/**
 * 启动时执行建表迁移（幂等）。DDL 内嵌，容器构建无需拷贝 .sql 资源。
 *
 * 标定能力上线迁移：
 * - batches/records 各加一列 calibration JSONB；
 * - 旧批次该列为 NULL，读出时按服务最初的默认标定（正向、零偏移）解释，
 *   回填语句同时把这份「历史认定」显式写回旧行，事后可查、口径不漂移；
 * - 新批次/新记录由仓储层保证写入非空标定快照。
 */
import pg from 'pg';
import { config } from '../config.js';
import { LEGACY_DEFAULT_CALIBRATION } from '../calibration.js';

const LEGACY_CALIBRATION_JSON = JSON.stringify(LEGACY_DEFAULT_CALIBRATION);

export const SCHEMA_DDL = `
CREATE TABLE IF NOT EXISTS batches (
  id          UUID PRIMARY KEY,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  note        TEXT,
  calibration JSONB NOT NULL DEFAULT '${LEGACY_CALIBRATION_JSON}'
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
  calibration JSONB NOT NULL DEFAULT '${LEGACY_CALIBRATION_JSON}',
  UNIQUE (batch_id, idx)
);

CREATE INDEX IF NOT EXISTS idx_records_batch ON records (batch_id, idx);
`;

/**
 * 增量迁移（对升级前已存在的库执行）：补列并把旧行显式回填为历史默认标定。
 * IF NOT EXISTS / WHERE NULL 保证重复执行幂等、不覆盖新数据。
 * 回填完成后置 NOT NULL + 默认值，使旧库约束与新建库一致。
 */
export const MIGRATION_DDL = `
ALTER TABLE batches ADD COLUMN IF NOT EXISTS calibration JSONB;
ALTER TABLE records ADD COLUMN IF NOT EXISTS calibration JSONB;

UPDATE batches SET calibration = '${LEGACY_CALIBRATION_JSON}'::jsonb WHERE calibration IS NULL;
UPDATE records SET calibration = '${LEGACY_CALIBRATION_JSON}'::jsonb WHERE calibration IS NULL;

ALTER TABLE batches ALTER COLUMN calibration SET DEFAULT '${LEGACY_CALIBRATION_JSON}'::jsonb;
ALTER TABLE records ALTER COLUMN calibration SET DEFAULT '${LEGACY_CALIBRATION_JSON}'::jsonb;
ALTER TABLE batches ALTER COLUMN calibration SET NOT NULL;
ALTER TABLE records ALTER COLUMN calibration SET NOT NULL;
`;

export async function runMigrations(connectionString: string = config.databaseUrl): Promise<void> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await client.query(SCHEMA_DDL);
    await client.query(MIGRATION_DDL);
  } finally {
    await client.end();
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
