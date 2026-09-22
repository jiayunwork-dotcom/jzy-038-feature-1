import { describe, expect, it, vi } from 'vitest';
import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import { PostgresBatchRepository } from '../src/persistence/postgres.js';
import { DEFAULT_CALIBRATION, makeCalibration } from '../src/calibration.js';

/** 内存假库：实现 pg.Pool 用到的 connect()/query()/end() 接口 */
function makeFakePool() {
  const batches = new Map<string, { id: string; created_at: Date; note: string | null; direction: string; reference_offset_deg: number }>();
  const records = new Map<string, Array<Record<string, unknown>>>();

  const query = vi.fn(async (text: string, params: unknown[] = []): Promise<QueryResult<QueryResultRow>> => {
    let rows: QueryResultRow[] = [];
    if (text.startsWith('INSERT INTO batches')) {
      rows = [{
        id: params[0],
        created_at: new Date('2026-09-19T00:00:00Z'),
        note: params[1] as string | null,
        direction: params[2] as string,
        reference_offset_deg: params[3] as number,
      }];
      batches.set(params[0] as string, rows[0]);
      records.set(params[0] as string, []);
    } else if (text.startsWith('UPDATE batches')) {
      const b = batches.get(params[0] as string);
      if (b) {
        b.note = params[1] as string | null;
        rows = [b];
      }
    } else if (text.startsWith('SELECT id, created_at, note, direction')) {
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
        calibration: params[7] === null ? null : JSON.parse(params[7] as string),
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
  it('追加记录在事务中按 MAX(idx)+1 编号，批次间隔离，行正确映射', async () => {
    const fake = makeFakePool();
    const repo = new PostgresBatchRepository(fake.pool);

    const b1 = await repo.createBatch({ note: 'one', calibration: DEFAULT_CALIBRATION });
    const b2 = await repo.createBatch({ note: 'two', calibration: makeCalibration('reverse', 35) });
    expect(b1.note).toBe('one');
    // 标定随批次持久化往返
    expect(b1.calibration).toEqual(DEFAULT_CALIBRATION);
    expect(b2.calibration).toEqual({ direction: 'reverse', referenceOffsetDeg: 35 });

    const r1 = await repo.appendRecord(b1.id, {
      status: 'ok', input: { k: 1 }, result: { kind: 'transform' }, errors: [],
      calibration: b1.calibration,
    });
    const r2 = await repo.appendRecord(b1.id, {
      status: 'rejected',
      input: { k: 2 },
      result: null,
      errors: [{ code: 'X', field: 'f', message: 'm' }],
      calibration: b1.calibration,
    });
    const r3 = await repo.appendRecord(b2.id, {
      status: 'ok', input: { k: 3 }, result: { kind: 'fault' }, errors: [],
      calibration: b2.calibration,
    });

    expect([r1.index, r2.index, r3.index]).toEqual([0, 1, 0]);
    expect(r1.batchId).toBe(b1.id);
    expect(r2.batchId).toBe(b1.id);
    expect(r3.batchId).toBe(b2.id);
    expect(r2.status).toBe('rejected');
    expect(r2.errors[0]!.code).toBe('X');
    // 每条记录带当批标定快照
    expect(r1.calibration).toEqual(DEFAULT_CALIBRATION);
    expect(r3.calibration).toEqual({ direction: 'reverse', referenceOffsetDeg: 35 });

    const list1 = await repo.listRecords(b1.id);
    expect(list1).toHaveLength(2);
    expect(list1.map((r) => r.index)).toEqual([0, 1]);

    const list2 = await repo.listRecords(b2.id);
    expect(list2).toHaveLength(1);

    const got = await repo.getRecord(b1.id, r2.id);
    expect(got!.id).toBe(r2.id);
    expect(await repo.getRecord(b1.id, 'nonexistent')).toBeNull();
    expect(await repo.getRecord(b2.id, r1.id)).toBeNull();
    expect(await repo.getBatch('nope')).toBeNull();

    // 备注可改，仓储不提供改标定的入口
    const patched = await repo.updateBatchNote(b1.id, 'renamed');
    expect(patched!.note).toBe('renamed');
    expect(patched!.calibration).toEqual(DEFAULT_CALIBRATION);

    // 追加走独立连接（事务）
    expect(fake.connect).toHaveBeenCalledTimes(3);
    await repo.close();
  });

  it('旧行（标定列缺失/为 NULL）宽容认定为服务默认标定，不产生孤儿数据', async () => {
    const fake = makeFakePool();
    const repo = new PostgresBatchRepository(fake.pool);
    const b = await repo.createBatch({ note: 'legacy', calibration: DEFAULT_CALIBRATION });

    // 模拟能力上线前写入的记录：没有 calibration 快照，批次列也按旧表缺省
    fake.records.get(b.id)!.push({
      id: 'legacy-record',
      batch_id: b.id,
      idx: 0,
      status: 'ok',
      input: { k: 1 },
      result: null,
      errors: [],
      // 刻意不带 calibration / direction / reference_offset_deg
      created_at: new Date('2026-09-19T00:00:00Z'),
    });
    // 同样模拟缺标定列的旧批次行
    fake.batches.set('legacy-batch', {
      id: 'legacy-batch',
      created_at: new Date('2026-09-19T00:00:00Z'),
      note: 'no calibration columns',
    } as never);

    const rec = await repo.getRecord(b.id, 'legacy-record');
    expect(rec!.calibration).toEqual(DEFAULT_CALIBRATION);

    const legacyBatch = await repo.getBatch('legacy-batch');
    expect(legacyBatch!.calibration).toEqual(DEFAULT_CALIBRATION);
    await repo.close();
  });
});
