import type { FastifyPluginAsync } from 'fastify';

export const meRoutes: FastifyPluginAsync = async (app) => {
  app.get('/api/me', async (req, reply) => {
    app.requireAuth(req);
    return reply.send({ user: req.user });
  });
};
