/**
 * HTTP 路由：以「换算批次」为中心。
 *
 *   POST   /batches                     开立批次（可带 calibration，缺省默认标定）
 *   PATCH  /batches/:id                 修改批次（仅备注可改；携带 calibration 一律 409 拒绝）
 *   POST   /batches/:id/records         向批次投入一条或多条记录（支持单对象或数组）
 *   GET    /batches/:id                 查批次（含全部记录）
 *   GET    /batches/:id/records         取批次内全部记录
 *   GET    /batches/:id/records/:rid    只取一条记录
 *   GET    /health                      健康检查
 *
 * 非法输入返回 4xx + 结构化错误体（error.code / error.fields[]），服务不崩溃。
 * 被校验拒绝的记录仍入库（status=rejected），单条投递交 422，批量投递交 200（逐条标状态）。
 *
 * 标定在开立阶段一次定死：开立时非法（非有限偏移、未知方向等）结构化 400 且不产生批次；
 * 批次存续期间所有记录都按批次冻结的标定处理，之后修改服务默认标定不影响既有批次。
 */

import type { FastifyInstance } from 'fastify';
import { processRecord } from '../records.js';
import { pickCalibrationRequest, parseCalibrationRequest } from '../calibration.js';
import type { BatchRepository } from '../persistence/repository.js';
import type { FieldError, StoredRecord } from '../types.js';

interface BatchParams {
  id: string;
}

interface RecordParams extends BatchParams {
  rid: string;
}

/** 把开立批次的结构化字段错误汇总为一个 400 错误体 */
function calibrationErrorBody(errors: FieldError[]) {
  return {
    error: {
      code: errors[0]!.code,
      message: '批次标定非法，批次未开立',
      fields: errors,
    },
  };
}

export async function registerRoutes(app: FastifyInstance, repo: BatchRepository): Promise<void> {
  app.get('/health', async () => ({ status: 'ok' }));

  // 开立批次（标定缺省 -> 服务默认；非法 -> 400 且不落库）
  app.post('/batches', async (request, reply) => {
    const body = (request.body ?? {}) as { note?: unknown; calibration?: unknown };

    const parsed = parseCalibrationRequest(pickCalibrationRequest(body));
    if (!parsed.ok) {
      return reply.code(400).send(calibrationErrorBody(parsed.errors));
    }

    const note = typeof body.note === 'string' ? body.note : body.note === undefined ? null : String(body.note);
    const batch = await repo.createBatch({ note, calibration: parsed.calibration });
    return reply.code(201).send(batch);
  });

  // 修改批次：仅备注可改；标定已冻结，任何修改尝试都明确拒绝（409），绝不静默接受或忽略
  app.patch<{ Params: BatchParams }>('/batches/:id', async (request, reply) => {
    const { id } = request.params;
    const batch = await repo.getBatch(id);
    if (!batch) {
      return reply.code(404).send({ error: { code: 'BATCH_NOT_FOUND', message: `批次 ${id} 不存在` } });
    }
    const body = (request.body ?? {}) as { note?: unknown; calibration?: unknown };

    if (body.calibration !== undefined) {
      return reply.code(409).send({
        error: {
          code: 'BATCH_CALIBRATION_FROZEN',
          field: 'calibration',
          message: `批次 ${id} 的相序标定已在开立时冻结（direction=${batch.calibration.direction}, referenceOffsetDeg=${batch.calibration.referenceOffsetDeg}），存续期间不可变更；如需其他标定请开立新批次`,
        },
      });
    }

    if (body.note === undefined) {
      return reply.code(200).send(batch);
    }
    const note = typeof body.note === 'string' ? body.note : body.note === null ? null : String(body.note);
    const updated = await repo.updateBatchNote(id, note);
    return reply.code(200).send(updated);
  });

  // 投入记录（单条或批量）——全部按批次冻结的标定处理
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

  // 查批次（含全部记录；批次与每条记录都带冻结标定快照）
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
    return { batchId: id, calibration: batch.calibration, count: records.length, records };
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
