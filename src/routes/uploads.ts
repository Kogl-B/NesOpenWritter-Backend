import type { FastifyPluginAsync } from 'fastify';

import { assertProjectOwnership } from '../lib/access.js';
import { getUserPlan, getStorageUsedBytes } from './account.js';
import { getTier, MB } from '../lib/tiers.js';
import { isR2Configured, objectSizeBytes, presignUpload } from '../lib/r2.js';
import { completeUploadSchema, presignUploadSchema } from '../lib/schemas.js';
import { rememberStoredFile } from '../lib/storedFileSync.js';
import { parseStoredKey } from '../lib/storedFiles.js';

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
      // Лимит места тарифа: заранее считаем и заявленный размер загрузки
      const tier = getTier(await getUserPlan(req.user!.id));
      if (tier.storageLimitMb != null && typeof input.sizeBytes === 'number' && input.sizeBytes > 0) {
        const used = await getStorageUsedBytes(req.user!.id);
        if (used + input.sizeBytes > tier.storageLimitMb * MB) {
          return reply.status(403).send({
            error: `Недостаточно места тарифа «${tier.name}»: занято ${(used / MB).toFixed(1)} МБ из ${tier.storageLimitMb} МБ, файл требует ${(input.sizeBytes / MB).toFixed(1)} МБ. Смените тариф в личном кабинете.`,
          });
        }
      }
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

  app.post<{ Params: ProjectParam }>(
    '/api/projects/:projectId/uploads/complete',
    async (req, reply) => {
      if (!(await assertProjectOwnership(req.params.projectId, req.user!.id))) {
        return reply.status(404).send({ error: 'Project not found' });
      }
      const input = completeUploadSchema.parse(req.body);
      const place = parseStoredKey(input.key, req.user!.id);
      if (!place || place.projectId !== req.params.projectId) {
        return reply.status(400).send({ error: 'Файл не из хранилища этого кабинета' });
      }
      const sizeBytes = await objectSizeBytes(input.key);
      if (sizeBytes == null) {
        return reply.status(404).send({ error: 'Файл в хранилище не найден' });
      }
      await rememberStoredFile({
        userId: req.user!.id,
        projectId: req.params.projectId,
        key: input.key,
        sizeBytes,
        kind: place.kind,
      });
      return { key: input.key, sizeBytes };
    },
  );
};
