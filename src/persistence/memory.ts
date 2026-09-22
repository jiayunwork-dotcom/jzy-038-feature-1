/**
 * 内存仓储：Map 按批次 id 隔离，记录在批次内按追加顺序编号。
 * 进程内并发安全（Node 单线程事件循环，await 期间不产生交错写）。
 * 标定在 createBatch 时写入批次对象即冻结，仓储不提供改标定的方法。
 *
 * 读取侧与 PostgreSQL 实现保持同一套宽容认定：能力上线前写入、不带 calibration
 * 字段的旧批次行，一律按服务默认标定认定（resolveStoredCalibration）。
 */

import { randomUUID } from 'node:crypto';
import { resolveStoredCalibration } from '../calibration.js';
import type { Batch, Calibration, StoredRecord } from '../types.js';
import type { BatchRepository, CreateBatchData } from './repository.js';

/** 行内可能是旧格式（无 calibration），读取时经 resolveStoredCalibration 补认定 */
interface LegacyBatchShape {
  id: string;
  createdAt: string;
  note: string | null;
  calibration?: Calibration;
}

interface BatchRow {
  batch: LegacyBatchShape;
  records: StoredRecord[];
}

function withCalibration(row: LegacyBatchShape): Batch {
  return { ...row, calibration: resolveStoredCalibration(row.calibration) };
}

export class InMemoryBatchRepository implements BatchRepository {
  private readonly batches = new Map<string, BatchRow>();

  async createBatch(data: CreateBatchData): Promise<Batch> {
    const batch: Batch = {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      note: data.note,
      calibration: data.calibration,
    };
    this.batches.set(batch.id, { batch, records: [] });
    return batch;
  }

  async getBatch(id: string): Promise<Batch | null> {
    const row = this.batches.get(id);
    return row ? withCalibration(row.batch) : null;
  }

  async updateBatchNote(batchId: string, note: string | null): Promise<Batch | null> {
    const row = this.batches.get(batchId);
    if (!row) return null;
    const updated: Batch = { ...withCalibration(row.batch), note };
    row.batch = updated;
    return updated;
  }

  /**
   * 测试/迁移辅助：植入一行"标定能力上线前"格式的批次（刻意不带 calibration），
   * 用于验证旧批次被宽容认定为服务默认标定。生产流程不应调用。
   */
  async seedLegacyBatchForCompatibility(data: { id?: string; createdAt?: string; note: string | null }): Promise<Batch> {
    const id = data.id ?? randomUUID();
    const legacy = {
      id,
      createdAt: data.createdAt ?? new Date('2026-01-01T00:00:00Z').toISOString(),
      note: data.note,
    };
    this.batches.set(id, { batch: legacy, records: [] });
    return withCalibration(legacy);
  }

  async appendRecord(batchId: string, record: Omit<StoredRecord, 'id' | 'batchId' | 'index' | 'createdAt'>): Promise<StoredRecord> {
    const row = this.batches.get(batchId);
    if (!row) throw new Error(`batch ${batchId} not found`);
    const stored: StoredRecord = {
      ...record,
      id: randomUUID(),
      batchId,
      index: row.records.length,
      createdAt: new Date().toISOString(),
    };
    row.records.push(stored);
    return stored;
  }

  async listRecords(batchId: string): Promise<StoredRecord[]> {
    const row = this.batches.get(batchId);
    return row ? [...row.records] : [];
  }

  async getRecord(batchId: string, recordId: string): Promise<StoredRecord | null> {
    const row = this.batches.get(batchId);
    if (!row) return null;
    return row.records.find((r) => r.id === recordId) ?? null;
  }

  async close(): Promise<void> {
    this.batches.clear();
  }
}
