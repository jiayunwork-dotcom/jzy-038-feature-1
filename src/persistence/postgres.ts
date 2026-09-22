/**
 * PostgreSQL 仓储：batches / records 两张表，JSONB 存输入、输出、错误与标定。
 * 批次内记录序号在插入事务中按 count 生成，配合 UNIQUE(batch_id, idx)
 * 保证并发投递时不串号、不覆盖。
 *
 * 标定快照随批次、随记录各存一份（calibration JSONB）。
 * 升级前建立的旧行该列为 NULL，读出时统一 resolveStoredCalibration
 * 补齐为服务最初的默认标定（正向、零偏移），旧批次不产生孤儿语义。
 */

import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import pg from 'pg';
import { resolveStoredCalibration } from '../calibration.js';
import type { Batch, Calibration, StoredRecord } from '../types.js';
import type { BatchRepository } from './repository.js';

type StoredRecordData = Omit<StoredRecord, 'id' | 'batchId' | 'index' | 'createdAt'>;

interface BatchRow {
  id: string;
  created_at: Date | string;
  note: string | null;
  calibration?: unknown;
}

function mapBatch(row: BatchRow): Batch {
  return {
    id: row.id,
    createdAt: (row.created_at instanceof Date ? row.created_at : new Date(row.created_at)).toISOString(),
    note: row.note,
    calibration: resolveStoredCalibration(row.calibration),
  };
}

interface RecordRow {
  id: string;
  batch_id: string;
  idx: number;
  created_at: Date | string;
  status: string;
  input: unknown;
  result: unknown;
  errors: unknown;
  calibration?: unknown;
}

function mapRecord(row: RecordRow): StoredRecord {
  return {
    id: row.id,
    batchId: row.batch_id,
    index: row.idx,
    createdAt: (row.created_at instanceof Date ? row.created_at : new Date(row.created_at)).toISOString(),
    status: row.status as StoredRecord['status'],
    input: row.input as StoredRecord['input'],
    result: row.result as StoredRecord['result'],
    errors: row.errors as StoredRecord['errors'],
    calibration: resolveStoredCalibration(row.calibration),
  };
}

const BATCH_COLUMNS = 'id, created_at, note, calibration';
const RECORD_COLUMNS = 'id, batch_id, idx, created_at, status, input, result, errors, calibration';

export class PostgresBatchRepository implements BatchRepository {
  private readonly pool: Pool;

  constructor(connectionStringOrPool: string | Pool) {
    this.pool =
      typeof connectionStringOrPool === 'string'
        ? new pg.Pool({ connectionString: connectionStringOrPool, max: 10 })
        : connectionStringOrPool;
  }

  async createBatch(note: string | null, calibration: Calibration): Promise<Batch> {
    const id = randomUUID();
    const res = await this.pool.query<BatchRow>(
      'INSERT INTO batches (id, note, calibration) VALUES ($1, $2, $3) RETURNING id, created_at, note, calibration',
      [id, note, JSON.stringify(calibration)],
    );
    return mapBatch(res.rows[0]!);
  }

  async getBatch(id: string): Promise<Batch | null> {
    const res = await this.pool.query<BatchRow>(`SELECT ${BATCH_COLUMNS} FROM batches WHERE id = $1`, [id]);
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
      const res = await client.query<RecordRow>(
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
      return mapRecord(res.rows[0]!);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async listRecords(batchId: string): Promise<StoredRecord[]> {
    const res = await this.pool.query<RecordRow>(
      `SELECT ${RECORD_COLUMNS} FROM records WHERE batch_id = $1 ORDER BY idx ASC`,
      [batchId],
    );
    return res.rows.map(mapRecord);
  }

  async getRecord(batchId: string, recordId: string): Promise<StoredRecord | null> {
    const res = await this.pool.query<RecordRow>(
      `SELECT ${RECORD_COLUMNS} FROM records WHERE batch_id = $1 AND id = $2`,
      [batchId, recordId],
    );
    return res.rows[0] ? mapRecord(res.rows[0]) : null;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
