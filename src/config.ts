/** 运行配置：存储后端、端口、数据库连接串、服务默认标定，全部可经环境变量覆盖。 */

import { LEGACY_DEFAULT_CALIBRATION, parseCalibrationSpec } from './calibration.js';
import type { Calibration, SequenceDirection } from './types.js';

export interface AppConfig {
  port: number;
  host: string;
  /** postgres 使用 PostgreSQL；memory 使用进程内内存（默认，测试与无数据库时） */
  storage: 'memory' | 'postgres';
  databaseUrl: string;
  /**
   * 服务默认标定：仅在「开立批次且未显式指定标定」时快照使用。
   * 已开立的批次（含标定能力上线前的旧批次）不随后续默认值变化而改变。
   */
  defaultCalibration: Calibration;
}

function loadDefaultCalibration(): Calibration {
  // 环境变量未设置时保持历史默认（正向、零偏移），升级即等价。
  const hasDirection = process.env.DEFAULT_SEQUENCE_DIRECTION !== undefined;
  const hasOffset = process.env.DEFAULT_REFERENCE_ANGLE_OFFSET_DEG !== undefined;
  if (!hasDirection && !hasOffset) return LEGACY_DEFAULT_CALIBRATION;

  const spec: { direction?: SequenceDirection; referenceAngleOffsetDeg?: number } = {};
  if (hasDirection) spec.direction = process.env.DEFAULT_SEQUENCE_DIRECTION as SequenceDirection;
  if (hasOffset) spec.referenceAngleOffsetDeg = Number(process.env.DEFAULT_REFERENCE_ANGLE_OFFSET_DEG);

  const parsed = parseCalibrationSpec(spec, LEGACY_DEFAULT_CALIBRATION);
  if (!parsed.ok) {
    throw new Error(
      `服务默认标定配置非法：${parsed.errors.map((e) => `${e.field}: ${e.message}`).join('; ')}`,
    );
  }
  return parsed.calibration;
}

export const config: AppConfig = {
  port: Number(process.env.PORT ?? 8080),
  host: process.env.HOST ?? '0.0.0.0',
  storage: (process.env.STORAGE ?? 'memory') === 'postgres' ? 'postgres' : 'memory',
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://symcomp:symcomp@localhost:5432/symcomp',
  defaultCalibration: loadDefaultCalibration(),
};
