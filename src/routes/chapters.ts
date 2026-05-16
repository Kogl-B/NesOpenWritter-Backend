import type { FastifyPluginAsync } from 'fastify';

import { prisma } from '../lib/prisma.js';
import { assertProjectOwnership, toJson } from '../lib/access.js';
import { chapterCreateSchema, chapterUpdateSchema } from '../lib/schemas.js';

type ProjectParam = { projectId: string };
type ChapterParam = { projectId: string; chapterId: string };

export const chapterRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', async (req) => {
    app.requireAuth(req);
  });

  app.get<{ Params: ProjectParam }>(
    '/api/projects/:projectId/chapters',
    async (req, reply) => {
      if (!(await assertProjectOwnership(req.params.projectId, req.user!.id))) {
        return reply.status(404).send({ error: 'Project not found' });
      }
      const chapters = await prisma.chapter.findMany({
        where: { projectId: req.params.projectId },
        orderBy: [{ orderIndex: 'asc' }, { createdAt: 'asc' }],
      });
      return { chapters };
    },
  );

  app.post<{ Params: ProjectParam }>(
    '/api/projects/:projectId/chapters',
    async (req, reply) => {
      if (!(await assertProjectOwnership(req.params.projectId, req.user!.id))) {
        return reply.status(404).send({ error: 'Project not found' });
      }
      const input = chapterCreateSchema.parse(req.body);
      if (input.parentId) {
        const parent = await prisma.chapter.findFirst({
          where: { id: input.parentId, projectId: req.params.projectId },
          select: { id: true },
        });
        if (!parent) return reply.status(400).send({ error: 'Parent chapter not in project' });
      }
      if (input.eventId) {
        const event = await prisma.timelineEvent.findFirst({
          where: { id: input.eventId, projectId: req.params.projectId },
          select: { id: true },
        });
        if (!event) return reply.status(400).send({ error: 'Event not in project' });
      }
      const chapter = await prisma.chapter.create({
        data: {
          projectId: req.params.projectId,
          parentId: input.parentId ?? null,
          kind: input.kind,
          title: input.title,
          summary: input.summary ?? null,
          content: toJson(input.content),
          orderIndex: input.orderIndex ?? 0,
          wordCount: input.wordCount ?? 0,
          eventId: input.eventId ?? null,
          locationId: input.locationId ?? null,
          metadata: toJson(input.metadata),
        },
      });
      return reply.status(201).send({ chapter });
    },
  );

  app.get<{ Params: ChapterParam }>(
    '/api/projects/:projectId/chapters/:chapterId',
    async (req, reply) => {
      if (!(await assertProjectOwnership(req.params.projectId, req.user!.id))) {
        return reply.status(404).send({ error: 'Project not found' });
      }
      const chapter = await prisma.chapter.findFirst({
        where: { id: req.params.chapterId, projectId: req.params.projectId },
      });
      if (!chapter) return reply.status(404).send({ error: 'Chapter not found' });
      return { chapter };
    },
  );

  app.patch<{ Params: ChapterParam }>(
    '/api/projects/:projectId/chapters/:chapterId',
    async (req, reply) => {
      if (!(await assertProjectOwnership(req.params.projectId, req.user!.id))) {
        return reply.status(404).send({ error: 'Project not found' });
      }
      const input = chapterUpdateSchema.parse(req.body);
      if (input.parentId && input.parentId === req.params.chapterId) {
        return reply.status(400).send({ error: 'Chapter cannot be its own parent' });
      }
      if (input.parentId) {
        const parent = await prisma.chapter.findFirst({
          where: { id: input.parentId, projectId: req.params.projectId },
          select: { id: true },
        });
        if (!parent) return reply.status(400).send({ error: 'Parent chapter not in project' });
      }
      const result = await prisma.chapter.updateMany({
        where: { id: req.params.chapterId, projectId: req.params.projectId },
        data: {
          ...(input.parentId !== undefined && { parentId: input.parentId }),
          ...(input.kind !== undefined && { kind: input.kind }),
          ...(input.title !== undefined && { title: input.title }),
          ...(input.summary !== undefined && { summary: input.summary }),
          ...(input.content !== undefined && { content: toJson(input.content) }),
          ...(input.orderIndex !== undefined && { orderIndex: input.orderIndex }),
          ...(input.wordCount !== undefined && { wordCount: input.wordCount }),
          ...(input.eventId !== undefined && { eventId: input.eventId }),
          ...(input.locationId !== undefined && { locationId: input.locationId }),
          ...(input.metadata !== undefined && { metadata: toJson(input.metadata) }),
        },
      });
      if (result.count === 0) return reply.status(404).send({ error: 'Chapter not found' });
      const chapter = await prisma.chapter.findUnique({
        where: { id: req.params.chapterId },
      });
      return { chapter };
    },
  );

  app.delete<{ Params: ChapterParam }>(
    '/api/projects/:projectId/chapters/:chapterId',
    async (req, reply) => {
      if (!(await assertProjectOwnership(req.params.projectId, req.user!.id))) {
        return reply.status(404).send({ error: 'Project not found' });
      }
      const result = await prisma.chapter.deleteMany({
        where: { id: req.params.chapterId, projectId: req.params.projectId },
      });
      if (result.count === 0) return reply.status(404).send({ error: 'Chapter not found' });
      return reply.status(204).send();
    },
  );
};
