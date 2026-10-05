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
import { initSentry, captureError } from './lib/sentry.js';

export async function buildApp(): Promise<FastifyInstance> {
  initSentry();

  const app = Fastify({
    logger: loggerConfig,
    disableRequestLogging: false,
    trustProxy: true,
  });

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

  return app;
}
