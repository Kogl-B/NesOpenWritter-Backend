import type { FastifyPluginAsync } from 'fastify';

import { prisma } from '../lib/prisma.js';
import { getProjectAccess } from '../lib/access.js';
import { dictionaryCreateSchema, dictionaryUpdateSchema } from '../lib/schemas.js';

export const dictionaryRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', async (req) => {
    app.requireAuth(req);
  });

  // Свои значения + значения текущего проекта. Чужие глобальные словари не видны.
  app.get('/api/dictionaries', async (req) => {
    const projectId = typeof (req.query as { projectId?: string }).projectId === 'string'
      ? (req.query as { projectId: string }).projectId
      : undefined;
    const userId = req.user!.id;
    const entries = await prisma.dictionaryEntry.findMany({
      where: {
        OR: [
          { userId, projectId: null },
          ...(projectId ? [{ projectId, userId }] : []),
        ],
      },
      orderBy: { value: 'asc' },
    });
    return { entries };
  });

  app.post('/api/dictionaries', async (req, reply) => {
    const input = dictionaryCreateSchema.parse(req.body);
    const userId = req.user!.id;
    const projectId = input.projectId ?? null;
    if (projectId) {
      const role = await getProjectAccess(projectId, userId);
      if (!role || role === 'viewer') {
        return reply.status(403).send({ error: 'Недостаточно прав, чтобы менять словарь проекта' });
      }
    }
    const existing = await prisma.dictionaryEntry.findFirst({
      where: { userId, projectId, kind: input.kind, value: input.value },
    });
    if (existing) return { entry: existing };
    const entry = await prisma.dictionaryEntry.create({
      data: { userId, projectId, kind: input.kind, value: input.value },
    });
    return reply.status(201).send({ entry });
  });

  app.patch<{ Params: { entryId: string } }>('/api/dictionaries/:entryId', async (req, reply) => {
    const input = dictionaryUpdateSchema.parse(req.body);
    const entry = await prisma.dictionaryEntry.findUnique({ where: { id: req.params.entryId } });
    if (!entry || entry.userId !== req.user!.id) {
      return reply.status(404).send({ error: 'Запись словаря не найдена' });
    }
    const projectId = input.projectId === undefined ? entry.projectId : input.projectId;
    if (projectId) {
      const role = await getProjectAccess(projectId, req.user!.id);
      if (!role || role === 'viewer') {
        return reply.status(403).send({ error: 'Недостаточно прав, чтобы менять словарь проекта' });
      }
    }
    const updated = await prisma.dictionaryEntry.update({
      where: { id: entry.id },
      data: { value: input.value, projectId },
    });
    return { entry: updated };
  });

  app.delete<{ Params: { entryId: string } }>('/api/dictionaries/:entryId', async (req, reply) => {
    const entry = await prisma.dictionaryEntry.findUnique({ where: { id: req.params.entryId } });
    if (!entry || entry.userId !== req.user!.id) {
      return reply.status(404).send({ error: 'Запись словаря не найдена' });
    }
    await prisma.dictionaryEntry.delete({ where: { id: entry.id } });
    return reply.status(204).send();
  });
};
