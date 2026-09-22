/**
 * PostgreSQL 仓储：batches / records 两张表，JSONB 存输入、输出与错误。
 * 批次内记录序号在插入事务中按 count 生成，配合 UNIQUE(batch_id, idx)
 * 保证并发投递时不串号、不覆盖。
 *
 * 标定随批次开立写入（direction / reference_offset_deg 两列）后冻结；
 * 表结构对能力上线前的旧行以 DEFAULT 'forward' / 0 兜底 —— 正是旧服务
 * 唯一支持的那套约定，旧批次读取时自然解析为默认标定。
 */

import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import pg from 'pg';
import type { Batch, Calibration, StoredRecord } from '../types.js';
import type { BatchRepository, CreateBatchData } from './repository.js';
import { resolveStoredCalibration } from '../calibration.js';

type StoredRecordData = Omit<StoredRecord, 'id' | 'batchId' | 'index' | 'createdAt'>;

const BATCH_COLUMNS = 'id, created_at, note, direction, reference_offset_deg';

function toIso(createdAt: Date | string): string {
  return (createdAt instanceof Date ? createdAt : new Date(createdAt)).toISOString();
}

function mapBatch(row: {
  id: string;
  created_at: Date | string;
  note: string | null;
  direction?: unknown;
  reference_offset_deg?: unknown;
}): Batch {
  // 宽容解析：旧行可能两列皆缺/为 null（DEFAULT 兜底外的历史脏数据），回落默认标定
  const calibration = resolveStoredCalibration({
    direction: row.direction ?? undefined,
    referenceOffsetDeg: row.reference_offset_deg ?? undefined,
  });
  return {
    id: row.id,
    createdAt: toIso(row.created_at),
    note: row.note,
    calibration,
  };
}

function mapRecord(row: {
  id: string;
  batch_id: string;
  idx: number;
  created_at: Date | string;
  status: string;
  input: unknown;
  result: unknown;
  errors: unknown;
  direction?: unknown;
  reference_offset_deg?: unknown;
  calibration?: unknown;
}): StoredRecord {
  // 记录优先用自身留存的标定快照（旧行没有该列时回落到批次列，再回落默认）
  const calibration: Calibration = resolveStoredCalibration(
    row.calibration ?? {
      direction: row.direction ?? undefined,
      referenceOffsetDeg: row.reference_offset_deg ?? undefined,
    },
  );
  return {
    id: row.id,
    batchId: row.batch_id,
    index: row.idx,
    createdAt: toIso(row.created_at),
    status: row.status as StoredRecord['status'],
    input: row.input as StoredRecord['input'],
    result: row.result as StoredRecord['result'],
    errors: row.errors as StoredRecord['errors'],
    calibration,
  };
}

const RECORD_COLUMNS = 'id, batch_id, idx, created_at, status, input, result, errors, calibration';

export class PostgresBatchRepository implements BatchRepository {
  private readonly pool: Pool;

  constructor(connectionStringOrPool: string | Pool) {
    this.pool =
      typeof connectionStringOrPool === 'string'
        ? new pg.Pool({ connectionString: connectionStringOrPool, max: 10 })
        : connectionStringOrPool;
  }

  async createBatch(data: CreateBatchData): Promise<Batch> {
    const id = randomUUID();
    const res = await this.pool.query(
      `INSERT INTO batches (id, note, direction, reference_offset_deg)
       VALUES ($1, $2, $3, $4)
       RETURNING ${BATCH_COLUMNS}`,
      [id, data.note, data.calibration.direction, data.calibration.referenceOffsetDeg],
    );
    return mapBatch(res.rows[0]!);
  }

  async getBatch(id: string): Promise<Batch | null> {
    const res = await this.pool.query(`SELECT ${BATCH_COLUMNS} FROM batches WHERE id = $1`, [id]);
    return res.rows[0] ? mapBatch(res.rows[0]) : null;
  }

  async updateBatchNote(batchId: string, note: string | null): Promise<Batch | null> {
    const res = await this.pool.query(
      `UPDATE batches SET note = $2 WHERE id = $1 RETURNING ${BATCH_COLUMNS}`,
      [batchId, note],
    );
    return res.rows[0] ? mapBatch(res.rows[0]) : null;
  }

  async appendRecord(batchId: string, record: StoredRecordData): Promise<StoredRecord> {
    const client: PoolClient = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const idxRes = await client.query<{ next_idx: number }>(
        'SELECT COALESCE(MAX(idx) + 1, 0) AS next_idx FROM records WHERE batch_id = $1',
        [batchId],
      );
      const nextIdx = idxRes.rows[0]!.next_idx;
      const res = await client.query(
        `INSERT INTO records (id, batch_id, idx, status, input, result, errors, calibration)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING ${RECORD_COLUMNS}`,
        [
          randomUUID(),
          batchId,
          nextIdx,
          record.status,
          JSON.stringify(record.input),
          record.result === null ? null : JSON.stringify(record.result),
          JSON.stringify(record.errors),
          JSON.stringify(record.calibration),
        ],
      );
      await client.query('COMMIT');
      return mapRecord(res.rows[0]);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async listRecords(batchId: string): Promise<StoredRecord[]> {
    const res = await this.pool.query(
      `SELECT ${RECORD_COLUMNS} FROM records WHERE batch_id = $1 ORDER BY idx ASC`,
      [batchId],
    );
    return res.rows.map(mapRecord);
  }

  async getRecord(batchId: string, recordId: string): Promise<StoredRecord | null> {
    const res = await this.pool.query(
      `SELECT ${RECORD_COLUMNS} FROM records WHERE batch_id = $1 AND id = $2`,
      [batchId, recordId],
    );
    return res.rows[0] ? mapRecord(res.rows[0]) : null;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
