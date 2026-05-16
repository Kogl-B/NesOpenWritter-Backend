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

export async function buildApp(): Promise<FastifyInstance> {
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
    return reply.status(500).send({ error: 'Internal Server Error' });
  });

  await app.register(authPlugin);

  await app.register(healthRoutes);
  await app.register(meRoutes);
  await app.register(projectRoutes);
  await app.register(characterRoutes);

  return app;
}
