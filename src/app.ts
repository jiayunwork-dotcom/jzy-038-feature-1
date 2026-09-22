/** Fastify 应用工厂：装配统一错误处理与路由，存储后端与默认标定由调用方注入（便于测试）。 */

import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import { registerRoutes } from './routes/records.js';
import type { BatchRepository } from './persistence/repository.js';
import { LEGACY_DEFAULT_CALIBRATION } from './calibration.js';
import type { Calibration } from './types.js';

export interface BuildAppOptions {
  /** 开立批次未显式指定标定时使用的服务默认标定（快照发生在开立时刻） */
  defaultCalibration?: Calibration;
}

export async function buildApp(repo: BatchRepository, options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: true });
  const defaultCalibration = options.defaultCalibration ?? LEGACY_DEFAULT_CALIBRATION;

  app.setErrorHandler((error: FastifyError, request, reply) => {
    request.log.error(error);
    // JSON 体解析失败等 -> 结构化 400，而不是 500
    if (error.statusCode === 400 || error.statusCode === 415) {
      return reply.status(400).send({
        error: { code: 'VALIDATION_FAILED', message: error.message },
      });
    }
    return reply.status(error.statusCode ?? 500).send({
      error: { code: 'VALIDATION_FAILED', message: error.message },
    });
  });

  await registerRoutes(app, repo, { defaultCalibration });

  app.addHook('onClose', async () => {
    await repo.close();
  });

  return app;
}
