import type { FastifyPluginAsync } from 'fastify';

import { assertProjectOwnership } from '../lib/access.js';
import { logBatchSchema } from '../lib/schemas.js';

type ProjectParam = { projectId: string };

export const logRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', async (req) => {
    app.requireAuth(req);
  });

  app.post<{ Params: ProjectParam }>(
    '/api/projects/:projectId/logs',
    async (req, reply) => {
      if (!(await assertProjectOwnership(req.params.projectId, req.user!.id))) {
        return reply.status(404).send({ error: 'Project not found' });
      }
      const { entries } = logBatchSchema.parse(req.body);
      for (const entry of entries) {
        const meta = {
          source: 'frontend',
          userId: req.user!.id,
          projectId: req.params.projectId,
          frontendTimestamp: entry.timestamp,
          context: entry.context,
        };
        switch (entry.level) {
          case 'error':
            app.log.error(meta, entry.message);
            break;
          case 'warn':
            app.log.warn(meta, entry.message);
            break;
          case 'info':
            app.log.info(meta, entry.message);
            break;
          case 'debug':
            app.log.debug(meta, entry.message);
            break;
        }
      }
      return reply.status(204).send();
    },
  );
};
