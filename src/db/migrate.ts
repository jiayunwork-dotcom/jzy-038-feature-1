/** 启动时执行建表迁移（幂等）。DDL 内嵌，容器构建无需拷贝 .sql 资源。 */
import pg from 'pg';
import { config } from '../config.js';

export const SCHEMA_DDL = `
CREATE TABLE IF NOT EXISTS batches (
  id          UUID PRIMARY KEY,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  note        TEXT
);

CREATE TABLE IF NOT EXISTS records (
  id          UUID PRIMARY KEY,
  batch_id    UUID NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
  idx         INTEGER NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  status      TEXT NOT NULL CHECK (status IN ('ok', 'rejected')),
  input       JSONB NOT NULL,
  result      JSONB,
  errors      JSONB NOT NULL DEFAULT '[]',
  UNIQUE (batch_id, idx)
);

-- 标定能力上线：批次开立时冻结相序方向与基准偏移。
-- 旧行由列 DEFAULT 兜底为 'forward' / 0 —— 正是旧服务唯一支持的默认标定，
-- 因此升级前后旧批次的计算语义完全等价，不存在"标定不明"的孤儿数据。
ALTER TABLE batches
  ADD COLUMN IF NOT EXISTS direction TEXT NOT NULL DEFAULT 'forward'
    CHECK (direction IN ('forward', 'reverse')),
  ADD COLUMN IF NOT EXISTS reference_offset_deg DOUBLE PRECISION NOT NULL DEFAULT 0;

-- 每条记录留存当时使用的标定快照（JSONB），事后回看任意记录即可辨认口径。
-- 旧行先置 NULL，读取侧 resolveStoredCalibration 按批次列/默认标定宽容认定。
ALTER TABLE records
  ADD COLUMN IF NOT EXISTS calibration JSONB;

CREATE INDEX IF NOT EXISTS idx_records_batch ON records (batch_id, idx);
`;

export async function runMigrations(connectionString: string = config.databaseUrl): Promise<void> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await client.query(SCHEMA_DDL);
  } finally {
    client.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runMigrations()
    .then(() => {
      console.log('migrations applied');
    })
    .catch((err) => {
      console.error('migration failed', err);
      process.exit(1);
    });
}
