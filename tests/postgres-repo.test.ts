import { describe, expect, it, vi } from 'vitest';
import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import { PostgresBatchRepository } from '../src/persistence/postgres.js';

/** 内存假库：实现 pg.Pool 用到的 connect()/query()/end() 接口 */
function makeFakePool() {
  const batches = new Map<string, { id: string; created_at: Date; note: string | null; calibration: unknown }>();
  const records = new Map<string, Array<Record<string, unknown>>>();

  const query = vi.fn(async (text: string, params: unknown[] = []): Promise<QueryResult<QueryResultRow>> => {
    let rows: QueryResultRow[] = [];
    if (text.startsWith('INSERT INTO batches')) {
      rows = [
        {
          id: params[0],
          created_at: new Date('2026-09-19T00:00:00Z'),
          note: params[1] as string | null,
          calibration: JSON.parse(params[2] as string),
        },
      ];
      batches.set(params[0] as string, rows[0]);
      records.set(params[0] as string, []);
    } else if (text.startsWith('SELECT id, created_at, note')) {
      const b = batches.get(params[0] as string);
      rows = b ? [b] : [];
    } else if (text.includes('MAX(idx) + 1')) {
      rows = [{ next_idx: (records.get(params[0] as string) ?? []).length }];
    } else if (text.startsWith('INSERT INTO records')) {
      const row = {
        id: params[0],
        batch_id: params[1],
        idx: params[2],
        status: params[3],
        input: JSON.parse(params[4] as string),
        result: params[5] ? JSON.parse(params[5] as string) : null,
        errors: JSON.parse(params[6] as string),
        calibration: JSON.parse(params[7] as string),
        created_at: new Date('2026-09-19T00:00:00Z'),
      };
      records.get(params[1] as string)!.push(row);
      rows = [row];
    } else if (text.includes('ORDER BY idx')) {
      rows = [...(records.get(params[0] as string) ?? [])].sort((a, b) => (a.idx as number) - (b.idx as number));
    } else if (text.includes('batch_id = $1 AND id = $2')) {
      rows = (records.get(params[0] as string) ?? []).filter((r) => r.id === params[1]);
    }
    return { rows, command: '', oid: 0, fields: [], rowCount: rows.length };
  });

  const connect = vi.fn(async (): Promise<PoolClient> => ({ query, release: vi.fn() }) as unknown as PoolClient);
  const pool = { connect, query, end: vi.fn(async () => undefined) } as unknown as Pool;
  return { pool, connect, batches, records };
}

describe('PostgresBatchRepository（连接桩）', () => {
  it('追加记录在事务中按 MAX(idx)+1 编号，批次间隔离，行正确映射，标定随批次/记录落库', async () => {
    const fake = makeFakePool();
    const repo = new PostgresBatchRepository(fake.pool);

    const calibration = { direction: 'reverse' as const, referenceAngleOffsetDeg: 12.5 };
    const b1 = await repo.createBatch('one', calibration);
    const b2 = await repo.createBatch('two', { direction: 'forward', referenceAngleOffsetDeg: 0 });
    expect(b1.note).toBe('one');
    expect(b1.calibration).toEqual(calibration);

    const r1 = await repo.appendRecord(b1.id, {
      status: 'ok',
      input: { k: 1 },
      result: { kind: 'transform' },
      errors: [],
      calibration,
    });
    const r2 = await repo.appendRecord(b1.id, {
      status: 'rejected',
      input: { k: 2 },
      result: null,
      errors: [{ code: 'X', field: 'f', message: 'm' }],
      calibration,
    });
    const r3 = await repo.appendRecord(b2.id, {
      status: 'ok',
      input: { k: 3 },
      result: { kind: 'fault' },
      errors: [],
      calibration: { direction: 'forward', referenceAngleOffsetDeg: 0 },
    });

    expect([r1.index, r2.index, r3.index]).toEqual([0, 1, 0]);
    expect(r1.batchId).toBe(b1.id);
    expect(r2.batchId).toBe(b1.id);
    expect(r3.batchId).toBe(b2.id);
    expect(r2.status).toBe('rejected');
    expect(r2.errors[0]!.code).toBe('X');
    // 每条记录冗余批次冻结标定快照
    expect(r1.calibration).toEqual(calibration);
    expect(r2.calibration).toEqual(calibration);
    expect(r3.calibration).toEqual({ direction: 'forward', referenceAngleOffsetDeg: 0 });

    const list1 = await repo.listRecords(b1.id);
    expect(list1).toHaveLength(2);
    expect(list1.map((r) => r.index)).toEqual([0, 1]);
    expect(list1[0]!.calibration).toEqual(calibration);

    const list2 = await repo.listRecords(b2.id);
    expect(list2).toHaveLength(1);

    const got = await repo.getRecord(b1.id, r2.id);
    expect(got!.id).toBe(r2.id);
    expect(got!.calibration).toEqual(calibration);
    expect(await repo.getRecord(b1.id, 'nonexistent')).toBeNull();
    expect(await repo.getRecord(b2.id, r1.id)).toBeNull();

    const reloaded = await repo.getBatch(b1.id);
    expect(reloaded!.calibration).toEqual(calibration);
    expect(await repo.getBatch('nope')).toBeNull();

    // 追加走独立连接（事务）
    expect(fake.connect).toHaveBeenCalledTimes(3);
    await repo.close();
  });

  it('旧数据（标定列为 NULL/缺省）读出时补齐为服务最初的默认标定，不产生孤儿批次', async () => {
    const fake = makeFakePool();
    const repo = new PostgresBatchRepository(fake.pool);

    // 模拟升级前的旧批次/旧记录行（calibration 为 null）
    fake.batches.set('legacy-id', {
      id: 'legacy-id',
      created_at: new Date('2025-01-01T00:00:00Z'),
      note: 'old',
      calibration: null,
    });
    fake.records.set('legacy-id', [
      {
        id: 'legacy-rec',
        batch_id: 'legacy-id',
        idx: 0,
        status: 'ok',
        input: {},
        result: { kind: 'transform' },
        errors: [],
        calibration: null,
        created_at: new Date('2025-01-01T00:00:00Z'),
      },
    ]);

    const batch = await repo.getBatch('legacy-id');
    expect(batch!.calibration).toEqual({ direction: 'forward', referenceAngleOffsetDeg: 0 });

    const list = await repo.listRecords('legacy-id');
    expect(list[0]!.calibration).toEqual({ direction: 'forward', referenceAngleOffsetDeg: 0 });
    const one = await repo.getRecord('legacy-id', 'legacy-rec');
    expect(one!.calibration).toEqual({ direction: 'forward', referenceAngleOffsetDeg: 0 });

    await repo.close();
  });
});
