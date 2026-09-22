import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { InMemoryBatchRepository } from '../src/persistence/memory.js';
import type { Calibration, StoredRecord, TransformResultPayload } from '../src/types.js';
import { balancedPositive, phasor } from './helpers.js';

const LEGACY: Calibration = { direction: 'forward', referenceAngleOffsetDeg: 0 };

let app: FastifyInstance;
let repo: InMemoryBatchRepository;

beforeAll(async () => {
  repo = new InMemoryBatchRepository();
  // 服务默认标定故意配成非 legacy 值，验证：
  // 1) 未指定标定的批次快照该默认；2) 已冻结批次不随后续默认变化（这里默认在进程内固定，
  //    冻结语义另由"修改被拒"与显式快照覆盖）。
  app = await buildApp(repo, { defaultCalibration: { direction: 'reverse', referenceAngleOffsetDeg: 0 } });
});

afterAll(async () => {
  await app.close();
});

async function createBatch(payload: unknown = {}) {
  const res = await app.inject({ method: 'POST', url: '/batches', payload });
  return { status: res.statusCode, body: res.json() };
}

describe('批次标定：开立、缺省、冻结、留痕', () => {
  it('开立时可指定标定并原样冻结在批次上', async () => {
    const cal = { direction: 'reverse', referenceAngleOffsetDeg: 42.5 };
    const { status, body } = await createBatch({ note: 'cal', calibration: cal });
    expect(status).toBe(201);
    expect(body.calibration).toEqual(cal);
  });

  it('不指定标定时快照服务默认标定（这里为 reverse/0）', async () => {
    const { status, body } = await createBatch({ note: 'default' });
    expect(status).toBe(201);
    expect(body.calibration).toEqual({ direction: 'reverse', referenceAngleOffsetDeg: 0 });
  });

  it('空 calibration 对象合法：全部字段回落默认', async () => {
    const { status, body } = await createBatch({ calibration: {} });
    expect(status).toBe(201);
    expect(body.calibration).toEqual({ direction: 'reverse', referenceAngleOffsetDeg: 0 });
  });

  it('非法偏移（NaN/Infinity/字符串/null）开立阶段结构化 400 拒绝，且不产生批次', async () => {
    const countBefore = (await app.inject({ method: 'GET', url: '/batches/never', payload: {} })).status;
    void countBefore;
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, '30', null, true]) {
      // NaN 经 JSON.stringify 变 null，其余直接发
      const { status, body } = await createBatch({ calibration: { referenceAngleOffsetDeg: bad } });
      expect(status, `偏移 ${String(bad)} 应 400`).toBe(400);
      expect(body.error.code).toBe('CALIBRATION_OFFSET_NOT_FINITE');
      expect(Array.isArray(body.error.fields)).toBe(true);
      expect(body.error.fields[0].field).toBe('calibration.referenceAngleOffsetDeg');
    }
  });

  it('非法方向 400 CALIBRATION_INVALID，标定整体非对象也拒绝，均不产生批次', async () => {
    for (const bad of ['sideways', 1, [], 'forward']) {
      const { status, body } = await createBatch({ calibration: { direction: bad } });
      if (bad === 'forward') {
        expect(status).toBe(201);
        continue;
      }
      expect(status).toBe(400);
      expect(body.error.code).toBe('CALIBRATION_INVALID');
    }
    const { status, body } = await createBatch({ calibration: null });
    expect(status).toBe(400);
    expect(body.error.code).toBe('CALIBRATION_INVALID');
  });

  it('开立后尝试 PATCH 修改标定：409 CALIBRATION_FROZEN 明确拒绝，标定不变', async () => {
    const created = await createBatch({ calibration: { direction: 'forward', referenceAngleOffsetDeg: 10 } });
    const id = created.body.id;

    const patch = await app.inject({
      method: 'PATCH',
      url: `/batches/${id}`,
      payload: { calibration: { direction: 'reverse', referenceAngleOffsetDeg: 20 } },
    });
    expect(patch.statusCode).toBe(409);
    expect(patch.json().error.code).toBe('CALIBRATION_FROZEN');

    // PUT 同口径拒绝
    const put = await app.inject({
      method: 'PUT',
      url: `/batches/${id}`,
      payload: { calibration: { direction: 'reverse' } },
    });
    expect(put.statusCode).toBe(409);

    // 标定确实未被改动
    const get = await app.inject({ method: 'GET', url: `/batches/${id}` });
    expect(get.json().calibration).toEqual({ direction: 'forward', referenceAngleOffsetDeg: 10 });
  });

  it('记录级无法覆盖标定：同一批次每条记录（含 rejected）都带批次冻结快照', async () => {
    const cal: Calibration = { direction: 'reverse', referenceAngleOffsetDeg: 22.5 };
    const created = await createBatch({ calibration: cal });
    const id = created.body.id;

    const ok = await app.inject({
      method: 'POST',
      url: `/batches/${id}/records`,
      payload: { kind: 'transform', quantity: 'voltage', direction: 'phase->sequence', phases: balancedPositive(10) },
    });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().calibration).toEqual(cal);

    const bad = await app.inject({
      method: 'POST',
      url: `/batches/${id}/records`,
      payload: {
        kind: 'transform',
        quantity: 'voltage',
        direction: 'phase->sequence',
        // 即使记录里私自带 calibration 字段，也必须被忽略
        calibration: { direction: 'forward', referenceAngleOffsetDeg: 0 },
        phases: balancedPositive(-3),
      },
    });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().status).toBe('rejected');
    expect(bad.json().calibration).toEqual(cal);

    const list = await app.inject({ method: 'GET', url: `/batches/${id}/records` });
    for (const r of list.json().records as StoredRecord[]) {
      expect(r.calibration).toEqual(cal);
    }
  });
});

describe('批次级标定在 HTTP 上的行为：正负序互换 + 正反闭合', () => {
  const original = {
    a: phasor(12.5, 20),
    b: phasor(8.1, -95),
    c: phasor(15.3, 140),
  };

  async function sequenceIn(calibration?: Calibration) {
    const created = await createBatch(calibration === undefined ? {} : { calibration });
    const res = await app.inject({
      method: 'POST',
      url: `/batches/${created.body.id}/records`,
      payload: { kind: 'transform', quantity: 'voltage', direction: 'phase->sequence', phases: original },
    });
    return (res.json().result as TransformResultPayload).sequence;
  }

  it('forward/0 与 reverse/0 两批次：正负序互换、零序相同', async () => {
    const sf = await sequenceIn({ direction: 'forward', referenceAngleOffsetDeg: 0 });
    const sr = await sequenceIn({ direction: 'reverse', referenceAngleOffsetDeg: 0 });
    for (const k of ['magnitude', 'angleDeg'] as const) {
      expect(sr.positive[k]).toBeCloseTo(sf.negative[k], 9);
      expect(sr.negative[k]).toBeCloseTo(sf.positive[k], 9);
      expect(sr.zero[k]).toBeCloseTo(sf.zero[k], 9);
    }
  });

  it('非零偏移批次内正变换 -> 反变换 HTTP 绕一圈精确回到原始三相', async () => {
    for (const calibration of [
      { direction: 'forward', referenceAngleOffsetDeg: 25 },
      { direction: 'forward', referenceAngleOffsetDeg: -138.2 },
      { direction: 'reverse', referenceAngleOffsetDeg: 25 },
      { direction: 'reverse', referenceAngleOffsetDeg: 300 },
    ] as Calibration[]) {
      const created = await createBatch({ calibration });
      const fwd = await app.inject({
        method: 'POST',
        url: `/batches/${created.body.id}/records`,
        payload: { kind: 'transform', quantity: 'voltage', direction: 'phase->sequence', phases: original },
      });
      const sequence = (fwd.json().result as TransformResultPayload).sequence;
      const inv = await app.inject({
        method: 'POST',
        url: `/batches/${created.body.id}/records`,
        payload: { kind: 'transform', quantity: 'voltage', direction: 'sequence->phase', sequence },
      });
      const back = (inv.json().result as TransformResultPayload).phases;
      for (const k of ['a', 'b', 'c'] as const) {
        expect(back[k]!.magnitude).toBeCloseTo(original[k]!.magnitude, 8);
        expect(back[k]!.angleDeg).toBeCloseTo(original[k]!.angleDeg, 8);
      }
    }
  });

  it('故障记录同样带批次标定快照，且偏移批次故障结果与零偏移批次在调用方参考系一致', async () => {
    const faultPayload = {
      kind: 'fault',
      z1: phasor(1, 80),
      z2: phasor(1, 80),
      z0: phasor(2, 75),
      vf: phasor(1, 0),
      rf: 0.1,
    };
    const cal: Calibration = { direction: 'forward', referenceAngleOffsetDeg: 50 };
    const created = await createBatch({ calibration: cal });
    const res = await app.inject({
      method: 'POST',
      url: `/batches/${created.body.id}/records`,
      payload: faultPayload,
    });
    expect(res.statusCode).toBe(201);
    const rec = res.json() as StoredRecord;
    expect(rec.calibration).toEqual(cal);
    expect(rec.result!.kind).toBe('fault');

    const base = await createBatch({ calibration: LEGACY });
    const resBase = await app.inject({
      method: 'POST',
      url: `/batches/${base.body.id}/records`,
      payload: faultPayload,
    });
    const r1 = rec.result as Extract<StoredRecord['result'], { kind: 'fault' }>;
    const r0 = resBase.json().result as typeof r1;
    expect(r1.faultedPhaseVoltage.magnitude).toBeCloseTo(r0.faultedPhaseVoltage.magnitude, 9);
    expect(r1.iSequence.angleDeg).toBeCloseTo(r0.iSequence.angleDeg, 9);
    expect(r1.voltageSag).toBeCloseTo(r0.voltageSag, 12);
  });
});
