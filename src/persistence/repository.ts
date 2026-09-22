/**
 * 批次与记录的持久化仓储接口。
 * 内存实现（测试/默认）与 PostgreSQL 实现（容器部署）实现同一接口，
 * 不同批次、同一批次不同记录各自独立存储，按 id/index 精确定位。
 *
 * 标定在批次开立时随批次写入并冻结；每条记录冗余一份标定快照。
 * 旧数据（标定列缺省/NULL）由实现层补齐为服务最初的默认标定。
 */

import type { Batch, Calibration, StoredRecord } from '../types.js';

export interface BatchRepository {
  createBatch(note: string | null, calibration: Calibration): Promise<Batch>;
  getBatch(id: string): Promise<Batch | null>;
  appendRecord(batchId: string, record: Omit<StoredRecord, 'id' | 'batchId' | 'index' | 'createdAt'>): Promise<StoredRecord>;
  listRecords(batchId: string): Promise<StoredRecord[]>;
  getRecord(batchId: string, recordId: string): Promise<StoredRecord | null>;
  close(): Promise<void>;
}
