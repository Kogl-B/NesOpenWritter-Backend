import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import sensible from '@fastify/sensible';
import compress from '@fastify/compress';
import { ZodError } from 'zod';

import { env } from './lib/env.js';
import { loggerConfig } from './lib/logger.js';
import authPlugin from './plugins/auth.js';
import { healthRoutes } from './routes/health.js';
import { meRoutes } from './routes/me.js';
import { accountRoutes } from './routes/account.js';
import { integrationRoutes } from './routes/integrations.js';
import { projectRoutes } from './routes/projects.js';
import { characterRoutes } from './routes/characters.js';
import { itemRoutes } from './routes/items.js';
import { locationRoutes } from './routes/locations.js';
import { eventRoutes } from './routes/events.js';
import { chapterRoutes } from './routes/chapters.js';
import { tagRoutes } from './routes/tags.js';
import { mapRoutes } from './routes/maps.js';
import { uploadRoutes } from './routes/uploads.js';
import { searchRoutes } from './routes/search.js';
import { logRoutes } from './routes/logs.js';
import { adminRoutes } from './routes/admin.js';
import { snapshotRoutes } from './routes/snapshots.js';
import { wikiRoutes } from './routes/wiki.js';
import { economyRoutes } from './routes/economy.js';
import { featureRoutes } from './routes/features.js';
import { wikiBookRoutes } from './routes/wikiBook.js';
import { initSentry, captureError } from './lib/sentry.js';
import { recordRequest, getDbStats, requestContext } from './lib/metrics.js';
import { getProjectAccess } from './lib/access.js';

export async function buildApp(): Promise<FastifyInstance> {
  initSentry();

  const app = Fastify({
    logger: loggerConfig,
    disableRequestLogging: false,
    trustProxy: true,
  });

  // --- Performance metrics middleware ---
  app.addHook('onRequest', async (req) => {
    (req as unknown as { _metricsStart: number })._metricsStart = performance.now();
    const metricsId = `${req.id}-${Date.now()}`;
    (req as unknown as { _metricsId: string })._metricsId = metricsId;
    // Контекст «прилипает» к async-цепочке запроса: Prisma-расширение
    // атрибутирует время БД-запросов этому HTTP-запросу (dbQueries/dbTimeMs)
    requestContext.enterWith({ metricsId });
  });

  app.addHook('onResponse', async (req, reply) => {
    const start = (req as unknown as { _metricsStart?: number })._metricsStart;
    const metricsId = (req as unknown as { _metricsId?: string })._metricsId;
    if (start == null) return;

    const durationMs = Math.round((performance.now() - start) * 100) / 100;
    const dbStats = metricsId ? getDbStats(metricsId) : { queries: 0, timeMs: 0 };

    recordRequest({
      route: req.routeOptions?.url ?? req.url.split('?')[0] ?? 'unknown',
      method: req.method,
      statusCode: reply.statusCode,
      durationMs,
      timestamp: Date.now(),
      dbQueries: dbStats.queries,
      dbTimeMs: dbStats.timeMs,
    });
  });

  // DB query timing via Prisma $use middleware is in lib/prisma.ts

  // gzip для JSON-ответов: списки сущностей (главы/персонажи) уходят сотнями KB,
  // без сжатия это главный трафик на мобильных клиентах. Только gzip — brotli
  // на динамических ответах дороже по CPU при сопоставимом выигрыше.
  // level 1: динамические ответы сжимаются на лету, дефолтный уровень 6 стоит
  // ~2x CPU ради −5% размера — на событийном цикле под нагрузкой CPU дороже.
  await app.register(compress, {
    encodings: ['gzip', 'identity'],
    threshold: 512,
    zlibOptions: { level: 1 },
  });
  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, {
    origin: env.CORS_ORIGIN.split(',').map((o) => o.trim()),
    credentials: true,
    // ETag нужен клиентскому 304-кэшу (api.ts) — без expose JS его не видит
    exposedHeaders: ['ETag'],
  });
  await app.register(cookie);
  await app.register(sensible);

  app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
    if (err instanceof ZodError) {
      return reply.status(400).send({
        error: 'ValidationError',
        details: err.flatten(),
      });
    }
    if (err.statusCode === 401) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }
    if (err.statusCode && err.statusCode < 500) {
      return reply.status(err.statusCode).send({ error: err.message });
    }
    app.log.error({ err }, 'unhandled error');
    captureError(err);
    return reply.status(500).send({ error: 'Internal Server Error' });
  });

  await app.register(authPlugin);

  // RBAC (BUG-79): роль «Читатель» (viewer) — только чтение. Все изменяющие
  // запросы внутри /api/projects/:projectId/* от viewer'а отклоняются.
  // Кэш доступа общий с assertProjectOwnership (lib/access.ts, R22) —
  // один набор запросов project+collaborator на промах, а не два.

  app.addHook('preHandler', async (req, reply) => {
    const m = req.url.match(/^\/api\/projects\/([^/]+)(\/|$)/);
    if (!m) return;
    if (!['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method)) return;
    const userId = (req as unknown as { user?: { id?: string } }).user?.id;
    if (!userId) return; // 401 обработает requireAuth в самом роуте
    const role = await getProjectAccess(m[1]!, userId);
    if (role === 'viewer') {
      return reply.status(403).send({
        error: 'Роль «Читатель» даёт доступ только для просмотра. Попросите владельца проекта изменить вашу роль.',
      });
    }
  });

  await app.register(healthRoutes);
  await app.register(meRoutes);
  await app.register(accountRoutes);
  await app.register(integrationRoutes);
  await app.register(projectRoutes);
  await app.register(characterRoutes);
  await app.register(itemRoutes);
  await app.register(locationRoutes);
  await app.register(eventRoutes);
  await app.register(chapterRoutes);
  await app.register(tagRoutes);
  await app.register(mapRoutes);
  await app.register(uploadRoutes);
  await app.register(searchRoutes);
  await app.register(logRoutes);
  await app.register(adminRoutes);
  await app.register(snapshotRoutes);
  await app.register(wikiRoutes);
  await app.register(economyRoutes);
  await app.register(featureRoutes);
  await app.register(wikiBookRoutes);

  return app;
}
