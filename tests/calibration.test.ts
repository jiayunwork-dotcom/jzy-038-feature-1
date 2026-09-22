import { describe, expect, it } from 'vitest';
import { Complex } from '../src/complex.js';
import { phasesToSequence as rawPhasesToSequence, sequenceToPhases as rawSequenceToPhases } from '../src/kernel/transform.js';
import { calculateSlgFault as rawFault } from '../src/kernel/fault.js';
import {
  CalibratedEngine,
  DEFAULT_CALIBRATION,
  makeCalibration,
  parseCalibrationRequest,
  resolveStoredCalibration,
} from '../src/calibration.js';
import type { PhaseTriplet, SequenceTriplet } from '../src/kernel/transform.js';
import { c, expectComplexClose, expectMagnitudeClose, phasor } from './helpers.js';
import type { ThreePhaseDTO } from '../src/types.js';

const TOL = 1e-9;

function toTriplet(p: ThreePhaseDTO): PhaseTriplet {
  return { a: c(p.a), b: c(p.b), c: c(p.c) };
}

function randomPhases(seed: number): PhaseTriplet {
  const r = (n: number) => {
    const x = Math.sin(seed * 91.7 + n * 47.3) * 43758.5453;
    return x - Math.floor(x);
  };
  return {
    a: Complex.polar(1 + 4 * r(1), -180 + 360 * r(2)),
    b: Complex.polar(1 + 4 * r(3), -180 + 360 * r(4)),
    c: Complex.polar(1 + 4 * r(5), -180 + 360 * r(6)),
  };
}

const SAMPLE: ThreePhaseDTO = {
  a: phasor(12.5, 20),
  b: phasor(8.1, -95),
  c: phasor(15.3, 140),
};

describe('反向标定（reverse）：正/负序正好对调，零序不受影响', () => {
  const fwd = new CalibratedEngine(makeCalibration('forward', 0));
  const rev = new CalibratedEngine(makeCalibration('reverse', 0));

  it('任意三相：reverse 批次的 positive = forward 批次的 negative（复数严格相等），零序相同', () => {
    for (let seed = 1; seed <= 30; seed++) {
      const p = randomPhases(seed);
      const sForward = fwd.phasesToSequence(p);
      const sReverse = rev.phasesToSequence(p);
      expectComplexClose(sReverse.positive, sForward.negative, TOL);
      expectComplexClose(sReverse.negative, sForward.positive, TOL);
      expectComplexClose(sReverse.zero, sForward.zero, TOL);
    }
  });

  it('验收样例：同一组输入两批次下正序负序互换、零序不变', () => {
    const sForward = fwd.phasesToSequence(toTriplet(SAMPLE));
    const sReverse = rev.phasesToSequence(toTriplet(SAMPLE));
    expectComplexClose(sReverse.positive, sForward.negative, TOL);
    expectComplexClose(sReverse.negative, sForward.positive, TOL);
    expectComplexClose(sReverse.zero, sForward.zero, TOL);
  });

  it('平衡正序三相在 reverse 批次下：调用方标定称之为负序（能量落到 negative 标签）', () => {
    // A∠0,B∠-120,C∠120 在默认约定下是正序；反向标定现场称之为负序
    const balanced: ThreePhaseDTO = { a: phasor(10, 0), b: phasor(10, -120), c: phasor(10, 120) };
    const s = rev.phasesToSequence(toTriplet(balanced));
    expectMagnitudeClose(s.negative.magnitude, 10);
    expect(s.positive.magnitude).toBeLessThan(1e-8);
    expect(s.zero.magnitude).toBeLessThan(1e-8);
    // 与 forward 批次对照：两边的标签正好对调
    const sFwd = fwd.phasesToSequence(toTriplet(balanced));
    expectComplexClose(s.positive, sFwd.negative, TOL);
    expectComplexClose(s.negative, sFwd.positive, TOL);
  });
});

describe('基准偏移角度：正变换→反变换严格可逆（任意偏移、任意方向）', () => {
  const offsets = [0, 1, 12.5, 37, -58.25, 137.7, 200, -270, 720];

  for (const offset of offsets) {
    for (const direction of ['forward', 'reverse'] as const) {
      it(`direction=${direction}, offset=${offset}°：随机三相正反闭合`, () => {
        const engine = new CalibratedEngine(makeCalibration(direction, offset));
        for (let seed = 1; seed <= 20; seed++) {
          const original = randomPhases(seed + offset * 7);
          const seq = engine.phasesToSequence(original);
          const back = engine.sequenceToPhases(seq);
          expectComplexClose(back.a, original.a, TOL);
          expectComplexClose(back.b, original.b, TOL);
          expectComplexClose(back.c, original.c, TOL);
        }
      });
    }
  }

  it('反方向也闭合：调用方序分量 → 三相 → 序分量，回到原序量', () => {
    for (const offset of [0, 45, -123.4]) {
      const engine = new CalibratedEngine(makeCalibration('reverse', offset));
      for (let seed = 1; seed <= 10; seed++) {
        const p = randomPhases(seed + 999);
        const seq0: SequenceTriplet = { zero: p.a.scale(0.3), positive: p.b, negative: p.c };
        const back = engine.phasesToSequence(engine.sequenceToPhases(seq0));
        expectComplexClose(back.zero, seq0.zero, TOL);
        expectComplexClose(back.positive, seq0.positive, TOL);
        expectComplexClose(back.negative, seq0.negative, TOL);
      }
    }
  });

  it('偏移两侧闭环：输入减 δ、输出加 δ，自足记录在调用方帧与默认批次同值（规范抵消）', () => {
    // 这正是"不能只在某一侧搬角度"的验收点：只归正输入不换回输出会残留 -δ。
    for (const delta of [30, -85, 215]) {
      const base = new CalibratedEngine(makeCalibration('forward', 0));
      const shifted = new CalibratedEngine(makeCalibration('forward', delta));
      const p = toTriplet(SAMPLE);
      const s0 = base.phasesToSequence(p);
      const s1 = shifted.phasesToSequence(p);
      for (const key of ['zero', 'positive', 'negative'] as const) {
        expectComplexClose(s1[key], s0[key], TOL);
      }
    }
  });

  it('跨帧换算：偏移批次输出（调用方帧）归正到服务帧后，等于默认批次输出旋转 -δ 的服务帧值', () => {
    for (const delta of [30, -85, 215]) {
      const base = new CalibratedEngine(makeCalibration('forward', 0));
      const shifted = new CalibratedEngine(makeCalibration('forward', delta));
      const p = toTriplet(SAMPLE);
      const s0 = base.phasesToSequence(p);
      const s1 = shifted.phasesToSequence(p);
      for (const key of ['zero', 'positive', 'negative'] as const) {
        // 调用方帧 -> 服务帧
        expectComplexClose(shifted.toServiceFrame(s1[key]), s0[key].mul(Complex.polar(1, -delta)), TOL);
        // 再换回调用方帧严格回到自身
        expectComplexClose(shifted.toCallerFrame(shifted.toServiceFrame(s1[key])), s1[key], TOL);
      }
    }
  });
});

describe('故障核算走同一套标定（不是只适配了变换模块）', () => {
  const faultInput = {
    z1: Complex.polar(1, 80),
    z2: Complex.polar(1.2, 78),
    z0: Complex.polar(2, 75),
    vf: Complex.polar(1, 10),
    rf: 0.1,
  };

  it('带偏移批次：调用方帧结果与默认批次逐量一致（两侧闭环，不残留偏移），标量跌落不变', () => {
    const base = new CalibratedEngine(DEFAULT_CALIBRATION);
    const o0 = base.calculateFault(faultInput);
    for (const delta of [42, -77.5, 200]) {
      const shifted = new CalibratedEngine(makeCalibration('forward', delta));
      const o1 = shifted.calculateFault(faultInput);
      for (const [got, want] of [
        [o1.iSequence, o0.iSequence],
        [o1.faultCurrent, o0.faultCurrent],
        [o1.faultedPhaseVoltage, o0.faultedPhaseVoltage],
        [o1.v0, o0.v0],
        [o1.v1, o0.v1],
        [o1.v2, o0.v2],
      ] as const) {
        expectComplexClose(got, want, TOL);
      }
      expect(o1.voltageSag).toBeCloseTo(o0.voltageSag, 12);
      // 跨帧：输出归正到服务帧后相对默认批次整体旋转 -δ，再换回严格回到自身
      expectComplexClose(shifted.toServiceFrame(o1.faultCurrent), o0.faultCurrent.mul(Complex.polar(1, -delta)), TOL);
      expectComplexClose(shifted.toCallerFrame(shifted.toServiceFrame(o1.faultCurrent)), o1.faultCurrent, TOL);
    }
  });

  it('reverse 批次（零偏移）：方向更名不改变 A 相 SLG 的序电流/故障相电压，序电压按标签命名', () => {
    const base = new CalibratedEngine(DEFAULT_CALIBRATION);
    const rev = new CalibratedEngine(makeCalibration('reverse', 0));
    const o0 = base.calculateFault(faultInput);
    const oR = rev.calculateFault(faultInput);
    expectComplexClose(oR.iSequence, o0.iSequence, TOL);
    expectComplexClose(oR.faultCurrent, o0.faultCurrent, TOL);
    expectComplexClose(oR.faultedPhaseVoltage, o0.faultedPhaseVoltage, TOL);
    expectComplexClose(oR.v0, o0.v0, TOL);
    expectComplexClose(oR.v1, o0.v1, TOL);
    expectComplexClose(oR.v2, o0.v2, TOL);
  });

  it('标定一致性：故障输出序电压用同一引擎反变换回三相，重建出的 A 相 = 故障相电压（任意方向/偏移）', () => {
    for (const direction of ['forward', 'reverse'] as const) {
      for (const delta of [0, 63, -128.25]) {
        for (const rf of [0, 0.1, 0.5]) {
          const engine = new CalibratedEngine(makeCalibration(direction, delta));
          const out = engine.calculateFault({ ...faultInput, rf });
          const phases = engine.sequenceToPhases({ zero: out.v0, positive: out.v1, negative: out.v2 });
          expectComplexClose(phases.a, out.faultedPhaseVoltage, 1e-8);
          expectComplexClose(out.faultCurrent, out.iSequence.scale(3), 1e-9);
        }
      }
    }
  });

  it('金属性接地在任意标定下故障相电压为零、V0+V1+V2=0', () => {
    for (const direction of ['forward', 'reverse'] as const) {
      const out = new CalibratedEngine(makeCalibration(direction, -63)).calculateFault({ ...faultInput, rf: 0 });
      expect(out.faultedPhaseVoltage.magnitude).toBeLessThan(1e-10);
      expectComplexClose(out.v0.add(out.v1).add(out.v2), Complex.ZERO, 1e-9);
    }
  });
});

describe('升级等价性：默认标定下新引擎与旧数学核心逐位一致', () => {
  const engine = new CalibratedEngine(DEFAULT_CALIBRATION);

  it('δ=0 恒等快路径：正/反变换输出与直接调用内核引用相同的复数（非仅容差一致）', () => {
    for (let seed = 1; seed <= 10; seed++) {
      const p = randomPhases(seed);
      const sEngine = engine.phasesToSequence(p);
      const sRaw = rawPhasesToSequence(p);
      expect(sEngine.positive.re).toBe(sRaw.positive.re);
      expect(sEngine.positive.im).toBe(sRaw.positive.im);
      expect(sEngine.zero.re).toBe(sRaw.zero.re);
      expect(sEngine.negative.im).toBe(sRaw.negative.im);

      const backEngine = engine.sequenceToPhases(sRaw);
      const backRaw = rawSequenceToPhases(sRaw);
      expect(backEngine.b.re).toBe(backRaw.b.re);
      expect(backEngine.c.im).toBe(backRaw.c.im);
    }
  });

  it('故障核算在默认标定下与直接调用内核逐位一致', () => {
    const e = engine.calculateFault({
      z1: Complex.polar(1, 80),
      z2: Complex.polar(1, 80),
      z0: Complex.polar(2, 75),
      vf: Complex.polar(1, 0),
      rf: 0.1,
    });
    const r = rawFault({
      z1: Complex.polar(1, 80),
      z2: Complex.polar(1, 80),
      z0: Complex.polar(2, 75),
      vf: Complex.polar(1, 0),
      rf: 0.1,
    });
    expect(e.iSequence.re).toBe(r.iSequence.re);
    expect(e.iSequence.im).toBe(r.iSequence.im);
    expect(e.faultCurrent.re).toBe(r.faultCurrent.re);
    expect(e.voltageSag).toBe(r.voltageSag);
  });
});

describe('开立标定的严格解析与旧数据宽容认定', () => {
  it('缺省 / 空对象 / 部分字段：补默认值', () => {
    expect(parseCalibrationRequest(undefined).ok).toBe(true);
    const empty = parseCalibrationRequest({});
    expect(empty.ok && empty.calibration).toEqual(DEFAULT_CALIBRATION);
    const partial = parseCalibrationRequest({ referenceOffsetDeg: 30 });
    expect(partial.ok && partial.calibration).toEqual({ direction: 'forward', referenceOffsetDeg: 30 });
    const revOnly = parseCalibrationRequest({ direction: 'reverse' });
    expect(revOnly.ok && revOnly.calibration).toEqual({ direction: 'reverse', referenceOffsetDeg: 0 });
  });

  it('非有限偏移（NaN/Infinity/字符串/null 字段）结构化拒绝', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -Number.Infinity, '30', true, null]) {
      const res = parseCalibrationRequest({ referenceOffsetDeg: bad });
      expect(res.ok, `偏移 ${String(bad)} 应被拒绝`).toBe(false);
      if (!res.ok) {
        expect(res.errors[0]!.code).toBe('CALIBRATION_OFFSET_NOT_FINITE');
        expect(res.errors[0]!.field).toBe('calibration.referenceOffsetDeg');
      }
    }
  });

  it('非法方向 / 结构损坏 / 未知字段结构化拒绝', () => {
    const badDir = parseCalibrationRequest({ direction: 'backwards' });
    expect(badDir.ok).toBe(false);
    if (!badDir.ok) expect(badDir.errors[0]!.code).toBe('CALIBRATION_DIRECTION_INVALID');

    for (const malformed of [[], 'forward', 42]) {
      const res = parseCalibrationRequest(malformed);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.errors[0]!.code).toBe('CALIBRATION_MALFORMED');
    }

    const unknown = parseCalibrationRequest({ direction: 'forward', extra: 1 });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.errors.some((e) => e.code === 'CALIBRATION_INVALID')).toBe(true);
  });

  it('旧批次（标定信息缺失/缺损）一律认定为服务默认标定', () => {
    expect(resolveStoredCalibration(undefined)).toEqual(DEFAULT_CALIBRATION);
    expect(resolveStoredCalibration(null)).toEqual(DEFAULT_CALIBRATION);
    expect(resolveStoredCalibration({})).toEqual(DEFAULT_CALIBRATION);
    expect(resolveStoredCalibration({ direction: 'weird' })).toEqual(DEFAULT_CALIBRATION);
    expect(resolveStoredCalibration({ referenceOffsetDeg: 30 }))
      .toEqual({ direction: 'forward', referenceOffsetDeg: 30 });
    expect(resolveStoredCalibration({ direction: 'weird', referenceOffsetDeg: Number.POSITIVE_INFINITY }))
      .toEqual(DEFAULT_CALIBRATION);
  });

  it('历史行中字段齐全或部分合法时按存储值认定（缺的字段补默认）', () => {
    expect(resolveStoredCalibration({ direction: 'reverse' }))
      .toEqual({ direction: 'reverse', referenceOffsetDeg: 0 });
    expect(resolveStoredCalibration({ direction: 'reverse', referenceOffsetDeg: 15 }))
      .toEqual({ direction: 'reverse', referenceOffsetDeg: 15 });
  });
});
