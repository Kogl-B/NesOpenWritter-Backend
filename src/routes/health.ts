import type { FastifyPluginAsync } from 'fastify';

export const healthRoutes: FastifyPluginAsync = async (app) => {
  app.get('/health', async () => ({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  }));

  app.get('/', async () => ({
    name: 'nesopenwritter-backend',
    version: '0.1.0',
    docs: 'See https://github.com/Kogl-B/NesOpenWritter for the migration plan.',
  }));
};
