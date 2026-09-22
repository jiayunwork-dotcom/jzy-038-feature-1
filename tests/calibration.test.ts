import { describe, expect, it } from 'vitest';
import { Complex } from '../src/complex.js';
import {
  forwardPhasesToKernel,
  forwardSequenceFromKernel,
  inversePhasesFromKernel,
  inverseSequenceToKernel,
  phasorFromKernel,
  phasorToKernel,
} from '../src/calibration.js';
import { phasesToSequence } from '../src/kernel/transform.js';
import { processRecord } from '../src/records.js';
import {
  LEGACY_DEFAULT_CALIBRATION,
  parseCalibrationSpec,
  resolveStoredCalibration,
} from '../src/calibration.js';
import type { Calibration, FaultResultPayload, RecordInput, SequenceDTO, StoredRecord, ThreePhaseDTO, TransformResultPayload } from '../src/types.js';
import { balancedPositive, c, expectComplexClose, expectMagnitudeClose, phasor } from './helpers.js';

const TOL = 1e-9;

const forwardZero: Calibration = { direction: 'forward', referenceAngleOffsetDeg: 0 };
const reverseZero: Calibration = { direction: 'reverse', referenceAngleOffsetDeg: 0 };

function randomPhases(seed: number): ThreePhaseDTO {
  const r = (n: number) => {
    const x = Math.sin(seed * 91.7 + n * 47.3) * 43758.5453;
    return x - Math.floor(x);
  };
  return {
    a: phasor(1 + 4 * r(1), -180 + 360 * r(2)),
    b: phasor(1 + 4 * r(3), -180 + 360 * r(4)),
    c: phasor(1 + 4 * r(5), -180 + 360 * r(6)),
  };
}

function forwardRecord(phases: ThreePhaseDTO): RecordInput {
  return { kind: 'transform', quantity: 'voltage', direction: 'phase->sequence', phases };
}

function inverseRecord(seq: SequenceDTO): RecordInput {
  return { kind: 'transform', quantity: 'voltage', direction: 'sequence->phase', sequence: seq };
}

function seqOf(rec: StoredRecord): SequenceDTO {
  return (rec.result as TransformResultPayload).sequence;
}

function phasesOf(rec: StoredRecord): ThreePhaseDTO {
  return (rec.result as TransformResultPayload).phases;
}

describe('标定原语：配对严格互逆（与方向、偏移无关）', () => {
  const offsets = [0, 1, -1, 37.5, 120, -215.7, 359.999, 1e6];
  const directions = ['forward', 'reverse'] as const;

  it('任意相量：toKernel 再 fromKernel 精确还原（含 δ=0 快通道）', () => {
    for (const direction of directions) {
      for (const offset of offsets) {
        const cal = { direction, referenceAngleOffsetDeg: offset };
        const z = Complex.polar(12.34, -67.8);
        const back = phasorFromKernel(phasorToKernel(z, cal), cal);
        expectComplexClose(back, z, TOL);
      }
    }
  });

  it('正变换输出原语即 P·M 的输出换名：反向时与内核 M·x 的 V1/V2 互换、V0 相同', () => {
    for (let seed = 1; seed <= 12; seed++) {
      const pDTO = randomPhases(seed);
      const p = { a: c(pDTO.a), b: c(pDTO.b), c: c(pDTO.c) };
      const kernelSeq = phasesToSequence(p);
      const out = forwardSequenceFromKernel(kernelSeq, reverseZero);
      // 槽位互换（可能含近零量，用绝对 1e-10 容差）
      expect(out.positive.sub(kernelSeq.negative).magnitude).toBeLessThan(1e-10);
      expect(out.negative.sub(kernelSeq.positive).magnitude).toBeLessThan(1e-10);
      expect(out.zero.sub(kernelSeq.zero).magnitude).toBeLessThan(1e-10);
      // 正向标定为恒等
      const fwdOut = forwardSequenceFromKernel(kernelSeq, forwardZero);
      expect(fwdOut).toBe(kernelSeq);
    }
  });

  it('偏移只是整体旋转：输入进内核相位增加 δ，换回后复原', () => {
    const z = Complex.polar(5, 30);
    const cal: Calibration = { direction: 'forward', referenceAngleOffsetDeg: 42 };
    const inKernel = phasorToKernel(z, cal);
    expectMagnitudeClose(inKernel.magnitude, 5);
    expect(inKernel.angleDeg).toBeCloseTo(72, 10);
    expect(phasorFromKernel(inKernel, cal).angleDeg).toBeCloseTo(30, 10);
  });
});

describe('正变换：正向/反向批次（零偏移）正负序正好互换，零序不变', () => {
  it('验收项：同一组输入在两个批次下 V1、V2 互换，V0 相同', () => {
    for (const seed of [1, 7, 42, 99]) {
      const input = randomPhases(seed);
      const fwd = processRecord(forwardRecord(input), forwardZero);
      const rev = processRecord(forwardRecord(input), reverseZero);
      expect(fwd.status).toBe('ok');
      expect(rev.status).toBe('ok');
      const sf = seqOf(fwd);
      const sr = seqOf(rev);
      // 同一组三相，反向标定的"正序"即正向标定算出的负序，反之亦然；零序与方向无关
      expectComplexClose(c(sr.positive), c(sf.negative), TOL);
      expectComplexClose(c(sr.negative), c(sf.positive), TOL);
      expectComplexClose(c(sr.zero), c(sf.zero), TOL);
    }
  });

  it('平衡三相：正向批次的平衡正序在反向批次里被认定为纯负序，反向接线反之', () => {
    // 内核视角的平衡正序：正向批次 -> positive；反向批次（B/C 对调解读）-> negative
    const posInput = balancedPositive(10, 15);
    const sf = seqOf(processRecord(forwardRecord(posInput), forwardZero));
    const sr = seqOf(processRecord(forwardRecord(posInput), reverseZero));
    expectMagnitudeClose(sf.positive.magnitude, 10);
    expect(sf.negative.magnitude).toBeLessThan(1e-8);
    expect(sr.positive.magnitude).toBeLessThan(1e-8);
    expectMagnitudeClose(sr.negative.magnitude, 10);
    expect(sf.zero.magnitude).toBeLessThan(1e-8);
    expect(sr.zero.magnitude).toBeLessThan(1e-8);

    // 调用方按反向接线送来平衡负序三相（B/C 与默认约定对调）：
    // 在反向批次里它应当被还原为纯正序
    const negInput = { a: phasor(8, 15), b: phasor(8, 135), c: phasor(8, -105) };
    const sr2 = seqOf(processRecord(forwardRecord(negInput), reverseZero));
    const sf2 = seqOf(processRecord(forwardRecord(negInput), forwardZero));
    expectMagnitudeClose(sr2.positive.magnitude, 8);
    expect(sr2.negative.magnitude).toBeLessThan(1e-8);
    expect(sf2.positive.magnitude).toBeLessThan(1e-8);
    expectMagnitudeClose(sf2.negative.magnitude, 8);
  });
});

describe('正反变换在带标定批次内严格闭合（验收项）', () => {
  const cases: Array<[Calibration['direction'], number]> = [
    ['forward', 0],
    ['forward', 25],
    ['forward', -138.2],
    ['forward', 720],
    ['reverse', 0],
    ['reverse', 25],
    ['reverse', -138.2],
    ['reverse', 359.5],
  ];

  it('phase -> sequence -> phase 回到原始三相（方向/偏移任意组合）', () => {
    for (let seed = 1; seed <= 10; seed++) {
      const original = randomPhases(seed);
      for (const [direction, offset] of cases) {
        const cal: Calibration = { direction, referenceAngleOffsetDeg: offset };
        const fwd = processRecord(forwardRecord(original), cal);
        const back = processRecord(inverseRecord(seqOf(fwd)), cal);
        expect(back.status).toBe('ok');
        const ph = phasesOf(back);
        for (const k of ['a', 'b', 'c'] as const) {
          expectComplexClose(c(ph[k]), c(original[k]), 1e-8);
        }
      }
    }
  });

  it('sequence -> phase -> sequence 反方向也闭合', () => {
    for (let seed = 100; seed <= 106; seed++) {
      const p = randomPhases(seed);
      const original: SequenceDTO = { zero: phasor(0.7, 10), positive: p.a, negative: p.b };
      for (const [direction, offset] of cases) {
        const cal: Calibration = { direction, referenceAngleOffsetDeg: offset };
        const inv = processRecord(inverseRecord(original), cal);
        const fwd = processRecord(forwardRecord(phasesOf(inv)), cal);
        const seq = seqOf(fwd);
        for (const k of ['zero', 'positive', 'negative'] as const) {
          expectComplexClose(c(seq[k]), c(original[k]), 1e-8);
        }
      }
    }
  });

  it('非零偏移：输入与输出都在调用方参考系时，正变换结果与零偏移批次逐量相等（纯参考系平移不变）', () => {
    // 偏移在进内核 (+δ) 与出内核 (-δ) 两侧成对抵消（旋转与对称分量矩阵可交换），
    // 因此调用方无需在服务外手动搬角度：同一组数字在自己参考系里得到同一组序分量。
    // 偏移的作用体现在可追溯性与跨设备一致性，而非改动调用方参考系内的结果。
    const input = randomPhases(3);
    for (const δ of [30, -75, 215.6]) {
      const noOffset = seqOf(processRecord(forwardRecord(input), forwardZero));
      const shifted = seqOf(processRecord(forwardRecord(input), { direction: 'forward', referenceAngleOffsetDeg: δ }));
      for (const k of ['zero', 'positive', 'negative'] as const) {
        expectComplexClose(c(shifted[k]), c(noOffset[k]), 1e-9);
      }
    }
  });

  it('偏移确实进入内核：直接核对归正后的内核相量相位 = 调用方相位 + δ', () => {
    const z = Complex.polar(5, 30);
    const cal: Calibration = { direction: 'forward', referenceAngleOffsetDeg: 30 };
    expect(phasorToKernel(z, cal).angleDeg).toBeCloseTo(60, 10);
  });
});

describe('故障核算与变换记录共用同一套标定（验收项）', () => {
  const faultInput: RecordInput = {
    kind: 'fault',
    z1: phasor(1, 80),
    z2: phasor(1.2, 78),
    z0: phasor(2, 75),
    vf: phasor(1, 20),
    rf: 0.1,
  };

  function faultOf(cal: Calibration): FaultResultPayload {
    const rec = processRecord(faultInput, cal);
    expect(rec.status).toBe('ok');
    return rec.result as FaultResultPayload;
  }

  it('零偏移正向批次结果与 legacy 默认标定逐字段一致（升级语义等价）', () => {
    const legacy = faultOf(LEGACY_DEFAULT_CALIBRATION);
    const explicit = faultOf(forwardZero);
    expect(explicit).toEqual(legacy);
  });

  it('非零偏移：故障结果与零偏移批次在调用方参考系内逐量相等（参考系平移不变），跌落不变', () => {
    const base = faultOf(forwardZero);
    for (const δ of [35, -70, 200]) {
      const shifted = faultOf({ direction: 'forward', referenceAngleOffsetDeg: δ });
      const checkPhasor = (actual: { magnitude: number; angleDeg: number }, ref: { magnitude: number; angleDeg: number }) => {
        expectComplexClose(c(actual), c(ref), 1e-9);
      };
      checkPhasor(shifted.iSequence, base.iSequence);
      checkPhasor(shifted.faultCurrent, base.faultCurrent);
      checkPhasor(shifted.faultedPhaseVoltage, base.faultedPhaseVoltage);
      checkPhasor(shifted.sequenceVoltages.zero, base.sequenceVoltages.zero);
      checkPhasor(shifted.sequenceVoltages.positive, base.sequenceVoltages.positive);
      checkPhasor(shifted.sequenceVoltages.negative, base.sequenceVoltages.negative);
      expectMagnitudeClose(shifted.voltageSag, base.voltageSag, 1e-12);
    }
  });

  it('偏移批次内闭合：故障的 iSequence/faultCurrent 与同批次反变换得到的 A 相一致', () => {
    const cal: Calibration = { direction: 'forward', referenceAngleOffsetDeg: -48 };
    const fault = faultOf(cal);

    // 用故障输出的序电流作为同批次反变换输入：A 相电流应等于故障相电流
    const inv = processRecord(
      {
        kind: 'transform',
        quantity: 'current',
        direction: 'sequence->phase',
        sequence: { zero: fault.iSequence, positive: fault.iSequence, negative: fault.iSequence },
      },
      cal,
    );
    expect(inv.status).toBe('ok');
    const phaseA = phasesOf(inv).a;
    expectComplexClose(c(phaseA), c(fault.faultCurrent), 1e-8);

    // 序网电压反变换回 A 相，应等于故障相电压（Va = V0+V1+V2）
    const invV = processRecord(
      {
        kind: 'transform',
        quantity: 'voltage',
        direction: 'sequence->phase',
        sequence: fault.sequenceVoltages,
      },
      cal,
    );
    expectComplexClose(c(phasesOf(invV).a), c(fault.faultedPhaseVoltage), 1e-8);
  });

  it('反向标定零偏移：SLG 落在 A 相（换名不动点），全部故障结果与正向批次逐字段一致', () => {
    const fwd = faultOf(forwardZero);
    const rev = faultOf(reverseZero);
    expect(rev).toEqual(fwd);
  });

  it('反向 + 非零偏移同时作用：与同批次变换模块的标定换算一致（跨模块共用原语）', () => {
    const cal: Calibration = { direction: 'reverse', referenceAngleOffsetDeg: 62.5 };
    const fault = faultOf(cal);
    // 序网电压经同一标定反变换回 A 相 = 故障相电压（跨模块闭合）
    const invV = processRecord(
      {
        kind: 'transform',
        quantity: 'voltage',
        direction: 'sequence->phase',
        sequence: fault.sequenceVoltages,
      },
      cal,
    );
    expectComplexClose(c(phasesOf(invV).a), c(fault.faultedPhaseVoltage), 1e-8);
  });
});

describe('旧批次语义等价：默认标定（正向零偏移）与升级前逐位一致', () => {
  it('processRecord 不带标定时等价于 LEGACY_DEFAULT_CALIBRATION', () => {
    const input = randomPhases(5);
    const implicit = processRecord(forwardRecord(input));
    const explicit = processRecord(forwardRecord(input), LEGACY_DEFAULT_CALIBRATION);
    expect(implicit.status).toBe('ok');
    expect((implicit.result as TransformResultPayload).sequence).toEqual(
      (explicit.result as TransformResultPayload).sequence,
    );
    // 即使未显式传入，记录也带历史默认标定快照（旧批次不是"标定不明"）
    expect(implicit.calibration).toEqual(LEGACY_DEFAULT_CALIBRATION);
  });

  it('旧记录重算：相同输入在历史默认标定下结果确定且可复现', () => {
    const fault: RecordInput = {
      kind: 'fault',
      z1: phasor(1, 80),
      z2: phasor(1, 80),
      z0: phasor(2, 75),
      vf: phasor(1, 0),
      rf: 0.1,
    };
    const first = processRecord(fault);
    const again = processRecord(fault, LEGACY_DEFAULT_CALIBRATION);
    expect(first.result).toEqual(again.result);
  });

  it('resolveStoredCalibration：NULL/缺字段/损坏行一律认定为历史默认标定', () => {
    expect(resolveStoredCalibration(null)).toEqual(LEGACY_DEFAULT_CALIBRATION);
    expect(resolveStoredCalibration(undefined)).toEqual(LEGACY_DEFAULT_CALIBRATION);
    expect(resolveStoredCalibration({})).toEqual(LEGACY_DEFAULT_CALIBRATION);
    expect(resolveStoredCalibration({ direction: 'weird', referenceAngleOffsetDeg: NaN })).toEqual(LEGACY_DEFAULT_CALIBRATION);
    expect(resolveStoredCalibration({ direction: 'reverse', referenceAngleOffsetDeg: 10 })).toEqual({
      direction: 'reverse',
      referenceAngleOffsetDeg: 10,
    });
  });
});

describe('批次开立标定合法性（结构化拒绝）', () => {
  it('非法偏移：NaN/Infinity/-Infinity/字符串/null 全部 CALIBRATION_OFFSET_NOT_FINITE', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, '30', null, true]) {
      const res = parseCalibrationSpec({ referenceAngleOffsetDeg: bad }, forwardZero);
      expect(res.ok, `偏移 ${String(bad)} 应被拒绝`).toBe(false);
      if (!res.ok) {
        expect(res.errors[0]!.code).toBe('CALIBRATION_OFFSET_NOT_FINITE');
        expect(res.errors[0]!.field).toBe('calibration.referenceAngleOffsetDeg');
      }
    }
  });

  it('非法方向：CALIBRATION_INVALID', () => {
    for (const bad of ['backwards', 0, 1, null, {}]) {
      const res = parseCalibrationSpec({ direction: bad }, forwardZero);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.errors[0]!.code).toBe('CALIBRATION_INVALID');
    }
  });

  it('标定整体不是对象：CALIBRATION_INVALID；字段缺失回落默认', () => {
    expect(parseCalibrationSpec(null, forwardZero).ok).toBe(false);
    expect(parseCalibrationSpec('x', forwardZero).ok).toBe(false);
    expect(parseCalibrationSpec([], forwardZero).ok).toBe(false);
    const absent = parseCalibrationSpec(undefined, { direction: 'reverse', referenceAngleOffsetDeg: 9 });
    expect(absent.ok).toBe(true);
    if (absent.ok) expect(absent.calibration).toEqual({ direction: 'reverse', referenceAngleOffsetDeg: 9 });
  });

  it('反向标定与任意有限偏移可自由组合，合法值原样保留（含负角、超大角）', () => {
    for (const offset of [0, -0.0, -359, 359.9999, -1e4, 12345.678]) {
      const res = parseCalibrationSpec({ direction: 'reverse', referenceAngleOffsetDeg: offset }, forwardZero);
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.calibration.direction).toBe('reverse');
        expect(res.calibration.referenceAngleOffsetDeg).toBe(offset);
      }
    }
  });

  it('部分指定：只给方向或只给偏移，另一项回落默认', () => {
    const r1 = parseCalibrationSpec({ direction: 'reverse' }, forwardZero);
    expect(r1.ok && r1.calibration).toEqual({ direction: 'reverse', referenceAngleOffsetDeg: 0 });
    const r2 = parseCalibrationSpec({ referenceAngleOffsetDeg: 18 }, forwardZero);
    expect(r2.ok && r2.calibration).toEqual({ direction: 'forward', referenceAngleOffsetDeg: 18 });
  });
});

describe('记录级标定留痕', () => {
  it('ok 与 rejected 记录都带开立批次的标定快照', () => {
    const cal: Calibration = { direction: 'reverse', referenceAngleOffsetDeg: 22.5 };
    const ok = processRecord(forwardRecord(randomPhases(1)), cal);
    expect(ok.calibration).toEqual(cal);
    const rejected = processRecord(forwardRecord({ a: phasor(-1, 0), b: phasor(10, -120), c: phasor(10, 120) }), cal);
    expect(rejected.status).toBe('rejected');
    expect(rejected.calibration).toEqual(cal);
  });
});
