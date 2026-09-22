/**
 * HTTP 路由：以「换算批次」为中心。
 *
 *   POST   /batches                     开立批次（可携带 calibration，缺省用服务默认）
 *   PATCH  /batches/:id                 批次标定为冻结项：任何修改尝试一律 409 拒绝
 *   POST   /batches/:id/records         向批次投入一条或多条记录（支持单对象或数组）
 *   GET    /batches/:id                 查批次（含全部记录）
 *   GET    /batches/:id/records         取批次内全部记录
 *   GET    /batches/:id/records/:rid    只取一条记录
 *   GET    /health                      健康检查
 *
 * 非法输入返回 4xx + 结构化错误体（error.code / error.fields[]），服务不崩溃。
 * 开立时标定非法：400 结构化拒绝且不产生批次。
 * 被校验拒绝的记录仍入库（status=rejected），单条投递交 422，批量投递交 200（逐条标状态）。
 */

import type { FastifyInstance } from 'fastify';
import { parseCalibrationSpec } from '../calibration.js';
import { processRecord } from '../records.js';
import type { BatchRepository } from '../persistence/repository.js';
import type { Calibration, StoredRecord } from '../types.js';

interface BatchParams {
  id: string;
}

interface RecordParams extends BatchParams {
  rid: string;
}

interface RouteDeps {
  /** 服务默认标定：仅在开立批次未显式指定时快照；可在装配时注入（测试用） */
  defaultCalibration: Calibration;
}

export async function registerRoutes(
  app: FastifyInstance,
  repo: BatchRepository,
  deps: RouteDeps = { defaultCalibration: { direction: 'forward', referenceAngleOffsetDeg: 0 } },
): Promise<void> {
  app.get('/health', async () => ({ status: 'ok' }));

  // 开立批次：标定在此刻解析并冻结
  app.post('/batches', async (request, reply) => {
    const body = (request.body ?? {}) as { note?: unknown; calibration?: unknown };
    const note = typeof body.note === 'string' ? body.note : body.note === undefined ? null : String(body.note);

    // 字段缺失（undefined）回落默认；显式 null 或结构非法一律拒绝，不产生批次
    const parsed = parseCalibrationSpec(
      Object.prototype.hasOwnProperty.call(body, 'calibration') ? body.calibration : undefined,
      deps.defaultCalibration,
    );
    if (!parsed.ok) {
      return reply.code(400).send({
        error: {
          code: parsed.errors[0]!.code,
          message: '批次标定非法，批次未开立',
          fields: parsed.errors,
        },
      });
    }

    const batch = await repo.createBatch(note, parsed.calibration);
    return reply.code(201).send(batch);
  });

  // 批次标定为冻结项：开立之后不接受任何标定变更（PATCH/PUT 同口径拒绝，不静默忽略）
  const rejectCalibrationChange = async (request: { body: unknown }, reply: { code: (n: number) => { send: (b: unknown) => unknown } }) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    if (Object.prototype.hasOwnProperty.call(body, 'calibration')) {
      return reply.code(409).send({
        error: {
          code: 'CALIBRATION_FROZEN',
          message: '批次标定在开立时已冻结，批次存续期间不允许变更（含 direction 与 referenceAngleOffsetDeg）',
          field: 'calibration',
        },
      });
    }
    return reply.code(400).send({
      error: { code: 'VALIDATION_FAILED', message: '批次开立后仅标定相关字段可被显式处理；当前批次不支持其他修改' },
    });
  };
  app.patch<{ Params: BatchParams }>('/batches/:id', async (request, reply) => {
    const { id } = request.params;
    const batch = await repo.getBatch(id);
    if (!batch) {
      return reply.code(404).send({ error: { code: 'BATCH_NOT_FOUND', message: `批次 ${id} 不存在` } });
    }
    return rejectCalibrationChange(request, reply);
  });
  app.put<{ Params: BatchParams }>('/batches/:id', async (request, reply) => {
    const { id } = request.params;
    const batch = await repo.getBatch(id);
    if (!batch) {
      return reply.code(404).send({ error: { code: 'BATCH_NOT_FOUND', message: `批次 ${id} 不存在` } });
    }
    return rejectCalibrationChange(request, reply);
  });

  // 投入记录（单条或批量）：全部记录强制使用批次冻结标定，记录级无法覆盖
  app.post<{ Params: BatchParams }>('/batches/:id/records', async (request, reply) => {
    const { id } = request.params;
    const batch = await repo.getBatch(id);
    if (!batch) {
      return reply.code(404).send({ error: { code: 'BATCH_NOT_FOUND', message: `批次 ${id} 不存在` } });
    }
    const rawList = Array.isArray(request.body) ? request.body : [request.body];
    if (rawList.length === 0) {
      return reply.code(400).send({ error: { code: 'VALIDATION_FAILED', message: '记录数组不能为空' } });
    }

    const stored: StoredRecord[] = [];
    for (const raw of rawList) {
      const processed = processRecord(raw, batch.calibration);
      stored.push(await repo.appendRecord(id, processed));
    }

    const allOk = stored.every((r) => r.status === 'ok');
    if (!Array.isArray(request.body)) {
      return reply.code(allOk ? 201 : 422).send(stored[0]);
    }
    return reply.code(allOk ? 201 : 200).send({ batchId: id, count: stored.length, records: stored });
  });

  // 查批次（含全部记录）
  app.get<{ Params: BatchParams }>('/batches/:id', async (request, reply) => {
    const { id } = request.params;
    const batch = await repo.getBatch(id);
    if (!batch) {
      return reply.code(404).send({ error: { code: 'BATCH_NOT_FOUND', message: `批次 ${id} 不存在` } });
    }
    const records = await repo.listRecords(id);
    return { ...batch, records };
  });

  // 取全部记录
  app.get<{ Params: BatchParams }>('/batches/:id/records', async (request, reply) => {
    const { id } = request.params;
    const batch = await repo.getBatch(id);
    if (!batch) {
      return reply.code(404).send({ error: { code: 'BATCH_NOT_FOUND', message: `批次 ${id} 不存在` } });
    }
    const records = await repo.listRecords(id);
    return { batchId: id, count: records.length, records };
  });

  // 取单条记录
  app.get<{ Params: RecordParams }>('/batches/:id/records/:rid', async (request, reply) => {
    const { id, rid } = request.params;
    const batch = await repo.getBatch(id);
    if (!batch) {
      return reply.code(404).send({ error: { code: 'BATCH_NOT_FOUND', message: `批次 ${id} 不存在` } });
    }
    const record = await repo.getRecord(id, rid);
    if (!record) {
      return reply.code(404).send({ error: { code: 'RECORD_NOT_FOUND', message: `批次 ${id} 下记录 ${rid} 不存在` } });
    }
    return record;
  });
}
