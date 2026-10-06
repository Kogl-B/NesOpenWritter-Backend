import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import sensible from '@fastify/sensible';
import { ZodError } from 'zod';

import { env } from './lib/env.js';
import { loggerConfig } from './lib/logger.js';
import authPlugin from './plugins/auth.js';
import { healthRoutes } from './routes/health.js';
import { meRoutes } from './routes/me.js';
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
import { recordRequest, getDbStats } from './lib/metrics.js';

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
    (req as unknown as { _metricsId: string })._metricsId = `${req.id}-${Date.now()}`;
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

  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, {
    origin: env.CORS_ORIGIN.split(',').map((o) => o.trim()),
    credentials: true,
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

  await app.register(healthRoutes);
  await app.register(meRoutes);
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
