import type { FastifyPluginAsync } from 'fastify';

import { assertProjectOwnership } from '../lib/access.js';
import { presignUpload, isR2Configured } from '../lib/r2.js';
import { presignUploadSchema } from '../lib/schemas.js';

type ProjectParam = { projectId: string };

export const uploadRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', async (req) => {
    app.requireAuth(req);
  });

  app.post<{ Params: ProjectParam }>(
    '/api/projects/:projectId/uploads/presign',
    async (req, reply) => {
      if (!(await assertProjectOwnership(req.params.projectId, req.user!.id))) {
        return reply.status(404).send({ error: 'Project not found' });
      }
      if (!isR2Configured()) {
        return reply.status(503).send({
          error: 'Object storage not configured',
          hint: 'Set R2_ACCOUNT_ID/R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY/R2_BUCKET in env',
        });
      }
      const input = presignUploadSchema.parse(req.body);
      const result = await presignUpload({
        projectId: req.params.projectId,
        userId: req.user!.id,
        kind: input.kind,
        filename: input.filename,
        contentType: input.contentType,
      });
      return { ...result, sizeBytes: input.sizeBytes ?? null };
    },
  );
};
