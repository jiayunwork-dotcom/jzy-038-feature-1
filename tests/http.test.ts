import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { InMemoryBatchRepository } from '../src/persistence/memory.js';
import { DEFAULT_CALIBRATION } from '../src/calibration.js';
import type { Batch, Calibration, FaultResultPayload, StoredRecord, TransformResultPayload } from '../src/types.js';
import { balancedPositive, phasor } from './helpers.js';

let app: FastifyInstance;
let repo: InMemoryBatchRepository;

beforeAll(async () => {
  repo = new InMemoryBatchRepository();
  app = await buildApp(repo);
});

afterAll(async () => {
  await app.close();
});

async function createBatch(note?: string, calibration?: Calibration) {
  const payload: Record<string, unknown> = {};
  if (note) payload.note = note;
  if (calibration) payload.calibration = calibration;
  const res = await app.inject({ method: 'POST', url: '/batches', payload });
  expect(res.statusCode).toBe(201);
  return res.json<Batch>();
}

describe('批次生命周期', () => {
  it('开立批次 -> 投记录 -> 整批取回 -> 单条取回', async () => {
    const batch = await createBatch('roundtrip over http');

    const addRes = await app.inject({
      method: 'POST',
      url: `/batches/${batch.id}/records`,
      payload: {
        kind: 'transform',
        quantity: 'voltage',
        direction: 'phase->sequence',
        phases: balancedPositive(10),
      },
    });
    expect(addRes.statusCode).toBe(201);
    const rec = addRes.json<StoredRecord>();
    expect(rec.status).toBe('ok');
    expect(rec.index).toBe(0);
    expect(rec.result!.kind).toBe('transform');

    const getBatch = await app.inject({ method: 'GET', url: `/batches/${batch.id}` });
    expect(getBatch.statusCode).toBe(200);
    const body = getBatch.json<{ id: string; records: StoredRecord[] }>();
    expect(body.records).toHaveLength(1);
    expect(body.records[0]!.id).toBe(rec.id);

    const getOne = await app.inject({ method: 'GET', url: `/batches/${batch.id}/records/${rec.id}` });
    expect(getOne.statusCode).toBe(200);
    expect(getOne.json<StoredRecord>().id).toBe(rec.id);
  });

  it('正反变换通过 HTTP 绕一圈回到原始三相（闭合）', async () => {
    const batch = await createBatch();
    const original = {
      a: phasor(12.5, 20),
      b: phasor(8.1, -95),
      c: phasor(15.3, 140),
    };

    const fwd = await app.inject({
      method: 'POST',
      url: `/batches/${batch.id}/records`,
      payload: { kind: 'transform', quantity: 'voltage', direction: 'phase->sequence', phases: original },
    });
    const fwdRec = fwd.json<StoredRecord>();
    const sequence = (fwdRec.result as TransformResultPayload).sequence;

    const inv = await app.inject({
      method: 'POST',
      url: `/batches/${batch.id}/records`,
      payload: { kind: 'transform', quantity: 'voltage', direction: 'sequence->phase', sequence },
    });
    const invRec = inv.json<StoredRecord>();
    const back = (invRec.result as TransformResultPayload).phases;

    for (const k of ['a', 'b', 'c'] as const) {
      expect(back[k]!.magnitude).toBeCloseTo(original[k]!.magnitude, 8);
      expect(back[k]!.angleDeg).toBeCloseTo(original[k]!.angleDeg, 8);
    }

    const all = await app.inject({ method: 'GET', url: `/batches/${batch.id}/records` });
    const listed = all.json<{ records: StoredRecord[] }>();
    expect(listed.records).toHaveLength(2);
    expect(listed.records[0]!.result).not.toBeNull();
    expect(listed.records[1]!.result).not.toBeNull();
  });

  it('批量投入：同一请求里多条记录各自独立留存，索引递增', async () => {
    const batch = await createBatch();
    const res = await app.inject({
      method: 'POST',
      url: `/batches/${batch.id}/records`,
      payload: [
        { kind: 'transform', quantity: 'current', direction: 'phase->sequence', phases: balancedPositive(100) },
        { kind: 'transform', quantity: 'current', direction: 'phase->sequence', phases: { a: phasor(0, 0) } },
        {
          kind: 'fault',
          z1: phasor(1, 80),
          z2: phasor(1, 80),
          z0: phasor(2, 75),
          vf: phasor(1, 0),
        },
      ],
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ count: number; records: StoredRecord[] }>();
    expect(body.count).toBe(3);
    expect(body.records.map((r) => r.index)).toEqual([0, 1, 2]);
    expect(body.records[0]!.status).toBe('ok');
    expect(body.records[1]!.status).toBe('rejected');
    expect(body.records[2]!.status).toBe('ok');
    // 被拒绝的记录同样留存
    const listed = await app.inject({ method: 'GET', url: `/batches/${batch.id}/records` });
    expect(listed.json<{ records: StoredRecord[] }>().records).toHaveLength(3);
  });

  it('故障记录经 HTTP 核算并留存', async () => {
    const batch = await createBatch();
    const res = await app.inject({
      method: 'POST',
      url: `/batches/${batch.id}/records`,
      payload: {
        kind: 'fault',
        z1: phasor(1, 80),
        z2: phasor(1, 80),
        z0: phasor(3, 70),
        vf: phasor(1, 0),
        rf: 0.1,
      },
    });
    expect(res.statusCode).toBe(201);
    const rec = res.json<StoredRecord>();
    expect(rec.status).toBe('ok');
    expect(rec.result!.kind).toBe('fault');
  });

  it('非法记录单条投递返回 422 + 结构化错误，且已留存', async () => {
    const batch = await createBatch();
    const res = await app.inject({
      method: 'POST',
      url: `/batches/${batch.id}/records`,
      payload: { kind: 'transform', quantity: 'voltage', direction: 'phase->sequence', phases: balancedPositive(-3) },
    });
    expect(res.statusCode).toBe(422);
    const rec = res.json<StoredRecord>();
    expect(rec.status).toBe('rejected');
    expect(rec.errors.length).toBeGreaterThan(0);
    expect(rec.errors[0]!.code).toBe('MAGNITUDE_NON_POSITIVE');
  });

  it('批次不存在：404 类型化错误', async () => {
    const res = await app.inject({ method: 'GET', url: '/batches/does-not-exist' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('BATCH_NOT_FOUND');
  });

  it('损坏的 JSON 体：结构化 400，服务不崩', async () => {
    const batch = await createBatch();
    const res = await app.inject({
      method: 'POST',
      url: `/batches/${batch.id}/records`,
      headers: { 'content-type': 'application/json' },
      payload: '{ not json',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_FAILED');
    // 服务仍可用
    const health = await app.inject({ method: 'GET', url: '/health' });
    expect(health.statusCode).toBe(200);
  });
});

describe('并发批次隔离', () => {
  it('并发开立多个批次并交错投递，结果不串号、不覆盖', async () => {
    const batches = await Promise.all([createBatch('c1'), createBatch('c2'), createBatch('c3'), createBatch('c4')]);

    // 每个批次并发投 12 条
    await Promise.all(
      batches.flatMap((b, bi) =>
        Array.from({ length: 12 }, (_, i) =>
          app.inject({
            method: 'POST',
            url: `/batches/${b.id}/records`,
            payload: {
              kind: 'transform',
              quantity: 'voltage',
              direction: 'phase->sequence',
              phases: balancedPositive(10 + bi, i * 3),
            },
          }),
        ),
      ),
    );

    for (let bi = 0; bi < batches.length; bi++) {
      const b = batches[bi]!;
      const res = await app.inject({ method: 'GET', url: `/batches/${b.id}/records` });
      const body = res.json<{ records: StoredRecord[] }>();
      expect(body.records).toHaveLength(12);
      // 索引唯一且连续
      expect(body.records.map((r) => r.index).sort((x, y) => x - y)).toEqual(Array.from({ length: 12 }, (_, i) => i));
      // 每条记录都属于本批次，正序幅值 = 投入的相电压幅值
      for (const r of body.records) {
        expect(r.batchId).toBe(b.id);
        const result = r.result as TransformResultPayload;
        expect(result.sequence.positive.magnitude).toBeCloseTo(10 + bi, 8);
      }
    }
  });
});

const SAMPLE_PHASES = {
  a: phasor(12.5, 20),
  b: phasor(8.1, -95),
  c: phasor(15.3, 140),
};

function forwardPayload(phases: typeof SAMPLE_PHASES) {
  return { kind: 'transform', quantity: 'voltage', direction: 'phase->sequence', phases };
}

async function postRecord(batchId: string, payload: unknown) {
  return app.inject({ method: 'POST', url: `/batches/${batchId}/records`, payload });
}

describe('批次级相序标定：开立、冻结与留痕', () => {
  it('开立时不带标定 -> 冻结为服务默认标定，并随批次与每条记录返回', async () => {
    const batch = await createBatch('default cal');
    expect(batch.calibration).toEqual(DEFAULT_CALIBRATION);

    const res = await postRecord(batch.id, forwardPayload(SAMPLE_PHASES));
    expect(res.statusCode).toBe(201);
    const rec = res.json<StoredRecord>();
    expect(rec.calibration).toEqual(DEFAULT_CALIBRATION);

    const got = await app.inject({ method: 'GET', url: `/batches/${batch.id}` });
    const body = got.json<Batch & { records: StoredRecord[] }>();
    expect(body.calibration).toEqual(DEFAULT_CALIBRATION);
    expect(body.records[0]!.calibration).toEqual(DEFAULT_CALIBRATION);
  });

  it('开立时显式标定 -> 原样冻结（reverse + 任意偏移）', async () => {
    const calibration = { direction: 'reverse', referenceOffsetDeg: -12.5 };
    const batch = await createBatch('explicit', calibration);
    expect(batch.calibration).toEqual(calibration);
  });

  it('非法偏移（NaN/Infinity/字符串）在开立阶段结构化 400 拒绝，且不产生批次', async () => {
    const before = await app.inject({ method: 'GET', url: '/health' });
    expect(before.statusCode).toBe(200);

    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, '30', true, null]) {
      const res = await app.inject({
        method: 'POST',
        url: '/batches',
        payload: { calibration: { referenceOffsetDeg: bad } },
      });
      expect(res.statusCode, `偏移 ${String(bad)} 应被 400 拒绝`).toBe(400);
      const body = res.json<{ error: { code: string; fields?: Array<{ code: string; field: string }> } }>();
      expect(body.error.code).toBe('CALIBRATION_OFFSET_NOT_FINITE');
      expect(body.error.fields?.[0]!.field).toBe('calibration.referenceOffsetDeg');
    }

    // 非法方向、损坏结构同样拒绝
    const badDir = await app.inject({ method: 'POST', url: '/batches', payload: { calibration: { direction: 'backwards' } } });
    expect(badDir.statusCode).toBe(400);
    expect(badDir.json().error.code).toBe('CALIBRATION_DIRECTION_INVALID');

    const malformed = await app.inject({ method: 'POST', url: '/batches', payload: { calibration: 30 } });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json().error.code).toBe('CALIBRATION_MALFORMED');
  });

  it('批次开立后修改标定：明确 409 拒绝（BATCH_CALIBRATION_FROZEN），原标定不变', async () => {
    const batch = await createBatch('frozen', { direction: 'forward', referenceOffsetDeg: 10 });

    const res = await app.inject({
      method: 'PATCH',
      url: `/batches/${batch.id}`,
      payload: { calibration: { direction: 'reverse', referenceOffsetDeg: 20 } },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('BATCH_CALIBRATION_FROZEN');

    // 即使提交与当前完全相同的标定也拒绝（冻结语义，而非"值相同就放行"）
    const same = await app.inject({
      method: 'PATCH',
      url: `/batches/${batch.id}`,
      payload: { calibration: { direction: 'forward', referenceOffsetDeg: 10 } },
    });
    expect(same.statusCode).toBe(409);

    const got = await app.inject({ method: 'GET', url: `/batches/${batch.id}` });
    expect(got.json<Batch>().calibration).toEqual({ direction: 'forward', referenceOffsetDeg: 10 });

    // 不存在的批次 -> 404
    const missing = await app.inject({
      method: 'PATCH',
      url: '/batches/no-such-batch',
      payload: { calibration: { direction: 'reverse' } },
    });
    expect(missing.statusCode).toBe(404);

    // 备注仍可修改，标定不被顺带改动
    const notePatch = await app.inject({ method: 'PATCH', url: `/batches/${batch.id}`, payload: { note: 'new note' } });
    expect(notePatch.statusCode).toBe(200);
    const patched = notePatch.json<Batch>();
    expect(patched.note).toBe('new note');
    expect(patched.calibration).toEqual({ direction: 'forward', referenceOffsetDeg: 10 });
  });
});

describe('标定下的换算与故障（HTTP 端到端）', () => {
  it('验收：同一组输入在 forward/0 与 reverse/0 两批次下正、负序正好互换，零序相同', async () => {
    const bFwd = await createBatch();
    const bRev = await createBatch(undefined, { direction: 'reverse', referenceOffsetDeg: 0 });

    const fwdRec = (await postRecord(bFwd.id, forwardPayload(SAMPLE_PHASES))).json<StoredRecord>();
    const revRec = (await postRecord(bRev.id, forwardPayload(SAMPLE_PHASES))).json<StoredRecord>();
    const sFwd = (fwdRec.result as TransformResultPayload).sequence;
    const sRev = (revRec.result as TransformResultPayload).sequence;

    for (const [a, b] of [
      [sRev.positive, sFwd.negative],
      [sRev.negative, sFwd.positive],
      [sRev.zero, sFwd.zero],
    ] as const) {
      expect(a.magnitude).toBeCloseTo(b.magnitude, 9);
      expect(a.angleDeg).toBeCloseTo(b.angleDeg, 8);
    }
    // 两条记录各自带着可辨认的标定快照
    expect(fwdRec.calibration.direction).toBe('forward');
    expect(revRec.calibration.direction).toBe('reverse');
  });

  it.each([0, 1, 37.5, -58.25, 215.3])('验收：偏移 %s° 批次先正后反，在容差内精确还原原始三相', async (delta) => {
    const batch = await createBatch(undefined, { direction: 'forward', referenceOffsetDeg: delta });

    const fwdRec = (await postRecord(batch.id, forwardPayload(SAMPLE_PHASES))).json<StoredRecord>();
    const sequence = (fwdRec.result as TransformResultPayload).sequence;

    const invRes = await postRecord(batch.id, {
      kind: 'transform',
      quantity: 'voltage',
      direction: 'sequence->phase',
      sequence,
    });
    expect(invRes.statusCode).toBe(201);
    const back = (invRes.json<StoredRecord>().result as TransformResultPayload).phases;

    for (const k of ['a', 'b', 'c'] as const) {
      expect(back[k]!.magnitude).toBeCloseTo(SAMPLE_PHASES[k]!.magnitude, 8);
      expect(back[k]!.angleDeg).toBeCloseTo(SAMPLE_PHASES[k]!.angleDeg, 8);
    }
  });

  it('验收：reverse + 非零偏移组合下先正后反同样精确还原', async () => {
    const batch = await createBatch(undefined, { direction: 'reverse', referenceOffsetDeg: 83.7 });
    const fwdRec = (await postRecord(batch.id, forwardPayload(SAMPLE_PHASES))).json<StoredRecord>();
    const sequence = (fwdRec.result as TransformResultPayload).sequence;
    const invRec = (await postRecord(batch.id, {
      kind: 'transform',
      quantity: 'voltage',
      direction: 'sequence->phase',
      sequence,
    })).json<StoredRecord>();
    const back = (invRec.result as TransformResultPayload).phases;
    for (const k of ['a', 'b', 'c'] as const) {
      expect(back[k]!.magnitude).toBeCloseTo(SAMPLE_PHASES[k]!.magnitude, 8);
      expect(back[k]!.angleDeg).toBeCloseTo(SAMPLE_PHASES[k]!.angleDeg, 8);
    }
  });

  it('验收：故障核算在带标定批次里同样经过标定换算 —— 序电压经同批次反变换重建出故障相电压', async () => {
    const batch = await createBatch(undefined, { direction: 'reverse', referenceOffsetDeg: -47.25 });
    const faultPayload = {
      kind: 'fault',
      z1: phasor(1, 80),
      z2: phasor(1.2, 78),
      z0: phasor(2, 75),
      vf: phasor(1, 18),
      rf: 0.1,
    };
    const faultRes = await postRecord(batch.id, faultPayload);
    expect(faultRes.statusCode).toBe(201);
    const fault = faultRes.json<StoredRecord>().result as FaultResultPayload;
    expect(fault.kind).toBe('fault');
    // 记录带的是当批标定，而非服务默认标定
    expect(faultRes.json<StoredRecord>().calibration).toEqual({ direction: 'reverse', referenceOffsetDeg: -47.25 });

    // 拿故障输出的序电压（调用方帧）在同一批次做反变换
    const invRes = await postRecord(batch.id, {
      kind: 'transform',
      quantity: 'voltage',
      direction: 'sequence->phase',
      sequence: fault.sequenceVoltages,
    });
    expect(invRes.statusCode).toBe(201);
    const rebuiltA = (invRes.json<StoredRecord>().result as TransformResultPayload).phases.a;
    expect(rebuiltA.magnitude).toBeCloseTo(fault.faultedPhaseVoltage.magnitude, 8);
    expect(rebuiltA.angleDeg).toBeCloseTo(fault.faultedPhaseVoltage.angleDeg, 7);
  });

  it('同一故障输入在 forward/0 与 reverse/0 批次结果一致，且非零偏移批次在调用方帧同样一致', async () => {
    const payload = {
      kind: 'fault',
      z1: phasor(1, 80),
      z2: phasor(1, 80),
      z0: phasor(2, 75),
      vf: phasor(1, 25),
      rf: 0.1,
    };
    const bFwd = await createBatch();
    const bRev = await createBatch(undefined, { direction: 'reverse', referenceOffsetDeg: 0 });
    const bShift = await createBatch(undefined, { direction: 'forward', referenceOffsetDeg: 55 });

    const f1 = ((await postRecord(bFwd.id, payload)).json<StoredRecord>().result) as FaultResultPayload;
    const f2 = ((await postRecord(bRev.id, payload)).json<StoredRecord>().result) as FaultResultPayload;
    const f3 = ((await postRecord(bShift.id, payload)).json<StoredRecord>().result) as FaultResultPayload;

    for (const got of [f2, f3]) {
      expect(got.iSequence.magnitude).toBeCloseTo(f1.iSequence.magnitude, 9);
      expect(got.iSequence.angleDeg).toBeCloseTo(f1.iSequence.angleDeg, 8);
      expect(got.faultedPhaseVoltage.magnitude).toBeCloseTo(f1.faultedPhaseVoltage.magnitude, 9);
      expect(got.voltageSag).toBeCloseTo(f1.voltageSag, 9);
    }
  });

  it('反方向闭合：序分量 -> 三相 -> 序分量，在 reverse+偏移批次同样回到原序量', async () => {
    const batch = await createBatch(undefined, { direction: 'reverse', referenceOffsetDeg: -41.2 });
    const sequence = {
      zero: phasor(2, 30),
      positive: phasor(9, -150),
      negative: phasor(4, 80),
    };
    const inv = (await postRecord(batch.id, {
      kind: 'transform',
      quantity: 'voltage',
      direction: 'sequence->phase',
      sequence,
    })).json<StoredRecord>();
    expect(inv.status).toBe('ok');
    const phases = (inv.result as TransformResultPayload).phases;

    const fwd = (await postRecord(batch.id, {
      kind: 'transform',
      quantity: 'voltage',
      direction: 'phase->sequence',
      phases,
    })).json<StoredRecord>();
    const back = (fwd.result as TransformResultPayload).sequence;
    for (const k of ['zero', 'positive', 'negative'] as const) {
      expect(back[k]!.magnitude).toBeCloseTo(sequence[k]!.magnitude, 8);
      expect(back[k]!.angleDeg).toBeCloseTo(sequence[k]!.angleDeg, 7);
    }
  });

  it('线电压（line）模式在带标定批次仍受同一零序约束，且正反闭合', async () => {
    const batch = await createBatch(undefined, { direction: 'reverse', referenceOffsetDeg: 25 });
    // 平衡正序对应的三个线电压
    const line = {
      a: phasor(17.320508075688, 30),
      b: phasor(17.320508075688, -90),
      c: phasor(17.320508075688, 150),
    };
    const fwd = (await postRecord(batch.id, {
      kind: 'transform', quantity: 'voltage', direction: 'phase->sequence', phaseMode: 'line', phases: line,
    })).json<StoredRecord>();
    expect(fwd.status).toBe('ok');
    const seq = (fwd.result as TransformResultPayload).sequence;
    expect(seq.zero.magnitude).toBeLessThan(1e-6);

    const inv = (await postRecord(batch.id, {
      kind: 'transform', quantity: 'voltage', direction: 'sequence->phase', phaseMode: 'line', sequence: seq,
    })).json<StoredRecord>();
    expect(inv.status).toBe('ok');
    const back = (inv.result as TransformResultPayload).phases;
    for (const k of ['a', 'b', 'c'] as const) {
      expect(back[k]!.magnitude).toBeCloseTo(line[k]!.magnitude, 7);
      expect(back[k]!.angleDeg).toBeCloseTo(line[k]!.angleDeg, 7);
    }
  });

  it('冻结独立性：批次开立后不受服务默认标定变化影响（同输入与开立时口径一致）', async () => {
    // 批次开立时显式 reverse/0；随后开立的默认批次即使口径不同，本批次仍按原标定计算
    const frozen = await createBatch('frozen-reverse', { direction: 'reverse', referenceOffsetDeg: 0 });
    const laterDefault = await createBatch('default created later');

    const a = ((await postRecord(frozen.id, forwardPayload(SAMPLE_PHASES))).json<StoredRecord>().result) as TransformResultPayload;
    const b = ((await postRecord(laterDefault.id, forwardPayload(SAMPLE_PHASES))).json<StoredRecord>().result) as TransformResultPayload;

    // 冻结批次的正序 = 后来默认批次的负序
    expect(a.sequence.positive.magnitude).toBeCloseTo(b.sequence.negative.magnitude, 9);
    expect(a.sequence.negative.magnitude).toBeCloseTo(b.sequence.positive.magnitude, 9);
    const refetched = (await app.inject({ method: 'GET', url: `/batches/${frozen.id}` })).json<Batch>();
    expect(refetched.calibration).toEqual({ direction: 'reverse', referenceOffsetDeg: 0 });
  });
});

describe('旧批次兼容（能力上线前无标定信息的数据）', () => {
  it('旧批次被认定为默认标定：可继续追加记录，重新核算旧输入与最初结果逐位一致', async () => {
    // 直接在仓储中植入上线前格式的批次（无 calibration 字段）
    const legacy = await repo.seedLegacyBatchForCompatibility({ note: 'created before calibration feature' });

    // 读取旧批次：标定补认为服务默认标定，而非"标定不明"
    const got = await app.inject({ method: 'GET', url: `/batches/${legacy.id}` });
    expect(got.statusCode).toBe(200);
    expect(got.json<Batch>().calibration).toEqual(DEFAULT_CALIBRATION);

    // 升级后向旧批次追加新记录：走默认标定，数值与服务升级前的口径一致
    const added = await postRecord(legacy.id, forwardPayload(SAMPLE_PHASES));
    expect(added.statusCode).toBe(201);
    const rec = added.json<StoredRecord>();
    expect(rec.calibration).toEqual(DEFAULT_CALIBRATION);

    // 同一输入重新核算：与刚追加（等价于"最初"默认标定结果）逐位一致，非仅容差一致
    const again = (await postRecord(legacy.id, forwardPayload(SAMPLE_PHASES))).json<StoredRecord>();
    const r1 = rec.result as TransformResultPayload;
    const r2 = again.result as TransformResultPayload;
    for (const k of ['zero', 'positive', 'negative'] as const) {
      expect(r2.sequence[k].magnitude).toBe(r1.sequence[k].magnitude);
      expect(r2.sequence[k].angleDeg).toBe(r1.sequence[k].angleDeg);
    }

    // 旧批次里的故障核算同样口径稳定
    const faultPayload = {
      kind: 'fault',
      z1: phasor(1, 80),
      z2: phasor(1, 80),
      z0: phasor(2, 75),
      vf: phasor(1, 0),
      rf: 0.1,
    };
    const f1 = ((await postRecord(legacy.id, faultPayload)).json<StoredRecord>().result) as FaultResultPayload;
    const f2 = ((await postRecord(legacy.id, faultPayload)).json<StoredRecord>().result) as FaultResultPayload;
    expect(f2.iSequence.magnitude).toBe(f1.iSequence.magnitude);
    expect(f2.iSequence.angleDeg).toBe(f1.iSequence.angleDeg);
    expect(f2.voltageSag).toBe(f1.voltageSag);

    // 旧批次的标定同样不可变更（不能借"历史数据"绕开冻结）
    const patch = await app.inject({
      method: 'PATCH',
      url: `/batches/${legacy.id}`,
      payload: { calibration: { direction: 'reverse' } },
    });
    expect(patch.statusCode).toBe(409);
  });
});
