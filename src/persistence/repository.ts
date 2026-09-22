/**
 * 批次与记录的持久化仓储接口。
 * 内存实现（测试/默认）与 PostgreSQL 实现（容器部署）实现同一接口，
 * 不同批次、同一批次不同记录各自独立存储，按 id/index 精确定位。
 *
 * 标定在开立时写入批次并冻结；仓储层不提供修改标定的入口（updateBatchNote
 * 只允许改备注），从存储侧杜绝批次存续期间标定漂移。
 */

import type { Batch, Calibration, StoredRecord } from '../types.js';

export interface CreateBatchData {
  note: string | null;
  calibration: Calibration;
}

export interface BatchRepository {
  createBatch(data: CreateBatchData): Promise<Batch>;
  getBatch(id: string): Promise<Batch | null>;
  /** 修改批次备注；标定不在可改字段内。备注为 null 表示清空。 */
  updateBatchNote(batchId: string, note: string | null): Promise<Batch | null>;
  appendRecord(batchId: string, record: Omit<StoredRecord, 'id' | 'batchId' | 'index' | 'createdAt'>): Promise<StoredRecord>;
  listRecords(batchId: string): Promise<StoredRecord[]>;
  getRecord(batchId: string, recordId: string): Promise<StoredRecord | null>;
  close(): Promise<void>;
}
