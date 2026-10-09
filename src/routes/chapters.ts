import type { FastifyPluginAsync } from 'fastify';

import { prisma } from '../lib/prisma.js';
import { assertProjectOwnership, toJson } from '../lib/access.js';
import {
  chapterCreateSchema,
  chapterUpdateSchema,
  chapterContentSchema,
  chapterReorderSchema,
  sceneMentionsReplaceSchema,
  chapterRevisionCreateSchema,
} from '../lib/schemas.js';

type ProjectParam = { projectId: string };
type ChapterParam = { projectId: string; chapterId: string };
type RevisionParam = { projectId: string; chapterId: string; revisionId: string };

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
        // Лёгкий список для дерева рукописи: summary/metadata/content тянутся
        // точечно fetchOne (loadSceneContent), иначе список из 1000+ сцен
        // раздувается до полумегабайта.
        select: {
          id: true, projectId: true, title: true, kind: true,
          parentId: true, orderIndex: true,
          wordCount: true,
          createdAt: true, updatedAt: true,
        },
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

  // ----- Content-only PATCH (autosave-friendly) ---------------------------

  app.patch<{ Params: ChapterParam }>(
    '/api/projects/:projectId/chapters/:chapterId/content',
    async (req, reply) => {
      if (!(await assertProjectOwnership(req.params.projectId, req.user!.id))) {
        return reply.status(404).send({ error: 'Project not found' });
      }
      const input = chapterContentSchema.parse(req.body);

      // Автоверсии: страховка от потери рукописи (BUG-63). Создаём ревизию
      // ПЕРЕД перезаписью, если (а) радикальное сокращение текста — похоже
      // на затирание, или (б) с последней ревизии прошло больше минуты.
      const before = await prisma.chapter.findUnique({
        where: { id: req.params.chapterId },
        select: { content: true, wordCount: true },
      });
      if (before && before.content != null) {
        const beforeWords = before.wordCount ?? 0;
        const afterWords = input.wordCount ?? 0;
        // Порог с 20 снижен до 4: сцены QA-раундов короче 20 слов и защита
        // не срабатывала — текст терялся безвозвратно. Любое сокращение
        // до ≤2 слов при ≥4 раньше — подозрительно на затирание.
        const looksLikeWipe = beforeWords >= 4 && afterWords <= 2;
        const lastRev = await prisma.chapterRevision.findFirst({
          where: { chapterId: req.params.chapterId },
          orderBy: { createdAt: 'desc' },
          select: { createdAt: true },
        });
        const stale = !lastRev || Date.now() - lastRev.createdAt.getTime() > 60_000;
        if (looksLikeWipe || stale) {
          await prisma.chapterRevision.create({
            data: {
              chapterId: req.params.chapterId,
              label: looksLikeWipe ? 'авто · перед затиранием' : 'автосохранение',
              content: before.content as object,
              wordCount: beforeWords,
            },
          });
        }
      }

      const result = await prisma.chapter.updateMany({
        where: { id: req.params.chapterId, projectId: req.params.projectId },
        data: {
          content: toJson(input.content),
          ...(input.wordCount !== undefined && { wordCount: input.wordCount }),
        },
      });
      if (result.count === 0) return reply.status(404).send({ error: 'Chapter not found' });
      const chapter = await prisma.chapter.findUnique({
        where: { id: req.params.chapterId },
        select: { id: true, wordCount: true, updatedAt: true },
      });
      return { chapter };
    },
  );

  // ----- Batch reorder ----------------------------------------------------

  app.post<{ Params: ProjectParam }>(
    '/api/projects/:projectId/chapters/reorder',
    async (req, reply) => {
      if (!(await assertProjectOwnership(req.params.projectId, req.user!.id))) {
        return reply.status(404).send({ error: 'Project not found' });
      }
      const input = chapterReorderSchema.parse(req.body);
      // Verify every id belongs to this project
      const ids = input.items.map((i) => i.id);
      const owned = await prisma.chapter.findMany({
        where: { id: { in: ids }, projectId: req.params.projectId },
        select: { id: true },
      });
      if (owned.length !== ids.length) {
        return reply.status(400).send({ error: 'Some chapters not in project' });
      }
      // Verify parentIds also belong to the same project (or null)
      const parentIds = input.items
        .map((i) => i.parentId)
        .filter((p): p is string => Boolean(p));
      if (parentIds.length > 0) {
        const parentsOk = await prisma.chapter.count({
          where: { id: { in: parentIds }, projectId: req.params.projectId },
        });
        if (parentsOk !== new Set(parentIds).size) {
          return reply.status(400).send({ error: 'Some parents not in project' });
        }
      }
      await prisma.$transaction(
        input.items.map((item) =>
          prisma.chapter.update({
            where: { id: item.id },
            data: { parentId: item.parentId ?? null, orderIndex: item.orderIndex },
          }),
        ),
      );
      return { updated: input.items.length };
    },
  );

  // ----- Scene mentions ---------------------------------------------------

  app.get<{ Params: ChapterParam }>(
    '/api/projects/:projectId/chapters/:chapterId/mentions',
    async (req, reply) => {
      if (!(await assertProjectOwnership(req.params.projectId, req.user!.id))) {
        return reply.status(404).send({ error: 'Project not found' });
      }
      const chapter = await prisma.chapter.findFirst({
        where: { id: req.params.chapterId, projectId: req.params.projectId },
        select: { id: true },
      });
      if (!chapter) return reply.status(404).send({ error: 'Chapter not found' });
      const mentions = await prisma.sceneMention.findMany({
        where: { sceneId: req.params.chapterId },
      });
      return { mentions };
    },
  );

  app.put<{ Params: ChapterParam }>(
    '/api/projects/:projectId/chapters/:chapterId/mentions',
    async (req, reply) => {
      if (!(await assertProjectOwnership(req.params.projectId, req.user!.id))) {
        return reply.status(404).send({ error: 'Project not found' });
      }
      const chapter = await prisma.chapter.findFirst({
        where: { id: req.params.chapterId, projectId: req.params.projectId },
        select: { id: true },
      });
      if (!chapter) return reply.status(404).send({ error: 'Chapter not found' });
      const input = sceneMentionsReplaceSchema.parse(req.body);

      // Replace strategy: delete existing, insert new (single transaction)
      const created = await prisma.$transaction([
        prisma.sceneMention.deleteMany({ where: { sceneId: req.params.chapterId } }),
        ...(input.mentions.length > 0
          ? [
              prisma.sceneMention.createMany({
                data: input.mentions.map((m) => ({
                  sceneId: req.params.chapterId,
                  entityType: m.entityType,
                  entityId: m.entityId,
                  count: m.count ?? 1,
                })),
                skipDuplicates: true,
              }),
            ]
          : []),
      ]);
      return { count: input.mentions.length, applied: created.length - 1 };
    },
  );

  // List all chapters/scenes that mention a given entity (for sidebar)
  app.get<{ Params: { projectId: string; entityType: string; entityId: string } }>(
    '/api/projects/:projectId/scene-mentions/:entityType/:entityId',
    async (req, reply) => {
      if (!(await assertProjectOwnership(req.params.projectId, req.user!.id))) {
        return reply.status(404).send({ error: 'Project not found' });
      }
      const mentions = await prisma.sceneMention.findMany({
        where: {
          entityType: req.params.entityType,
          entityId: req.params.entityId,
          scene: { projectId: req.params.projectId },
        },
        include: {
          scene: { select: { id: true, title: true, kind: true, parentId: true } },
        },
      });
      return { mentions };
    },
  );

  // ----- Chapter revisions / drafts ---------------------------------------

  app.get<{ Params: ChapterParam }>(
    '/api/projects/:projectId/chapters/:chapterId/revisions',
    async (req, reply) => {
      if (!(await assertProjectOwnership(req.params.projectId, req.user!.id))) {
        return reply.status(404).send({ error: 'Project not found' });
      }
      const chapter = await prisma.chapter.findFirst({
        where: { id: req.params.chapterId, projectId: req.params.projectId },
        select: { id: true },
      });
      if (!chapter) return reply.status(404).send({ error: 'Chapter not found' });
      const revisions = await prisma.chapterRevision.findMany({
        where: { chapterId: req.params.chapterId },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          chapterId: true,
          label: true,
          wordCount: true,
          createdAt: true,
        },
      });
      return { revisions };
    },
  );

  // Snapshot current content as a new revision
  app.post<{ Params: ChapterParam }>(
    '/api/projects/:projectId/chapters/:chapterId/revisions',
    async (req, reply) => {
      if (!(await assertProjectOwnership(req.params.projectId, req.user!.id))) {
        return reply.status(404).send({ error: 'Project not found' });
      }
      const chapter = await prisma.chapter.findFirst({
        where: { id: req.params.chapterId, projectId: req.params.projectId },
        select: { content: true, wordCount: true },
      });
      if (!chapter) return reply.status(404).send({ error: 'Chapter not found' });
      const input = chapterRevisionCreateSchema.parse(req.body ?? {});
      const revision = await prisma.chapterRevision.create({
        data: {
          chapterId: req.params.chapterId,
          label: input.label ?? null,
          content: chapter.content as object,
          wordCount: chapter.wordCount,
        },
      });
      return reply.status(201).send({
        revision: {
          id: revision.id,
          chapterId: revision.chapterId,
          label: revision.label,
          wordCount: revision.wordCount,
          createdAt: revision.createdAt,
        },
      });
    },
  );

  app.get<{ Params: RevisionParam }>(
    '/api/projects/:projectId/chapters/:chapterId/revisions/:revisionId',
    async (req, reply) => {
      if (!(await assertProjectOwnership(req.params.projectId, req.user!.id))) {
        return reply.status(404).send({ error: 'Project not found' });
      }
      const revision = await prisma.chapterRevision.findFirst({
        where: {
          id: req.params.revisionId,
          chapterId: req.params.chapterId,
          chapter: { projectId: req.params.projectId },
        },
      });
      if (!revision) return reply.status(404).send({ error: 'Revision not found' });
      return { revision };
    },
  );

  // Restore a revision into the chapter
  app.post<{ Params: RevisionParam }>(
    '/api/projects/:projectId/chapters/:chapterId/revisions/:revisionId/restore',
    async (req, reply) => {
      if (!(await assertProjectOwnership(req.params.projectId, req.user!.id))) {
        return reply.status(404).send({ error: 'Project not found' });
      }
      const revision = await prisma.chapterRevision.findFirst({
        where: {
          id: req.params.revisionId,
          chapterId: req.params.chapterId,
          chapter: { projectId: req.params.projectId },
        },
      });
      if (!revision) return reply.status(404).send({ error: 'Revision not found' });
      const chapter = await prisma.chapter.update({
        where: { id: req.params.chapterId },
        data: {
          content: revision.content as object,
          wordCount: revision.wordCount,
        },
      });
      return { chapter };
    },
  );

  app.delete<{ Params: RevisionParam }>(
    '/api/projects/:projectId/chapters/:chapterId/revisions/:revisionId',
    async (req, reply) => {
      if (!(await assertProjectOwnership(req.params.projectId, req.user!.id))) {
        return reply.status(404).send({ error: 'Project not found' });
      }
      // verify chain
      const ok = await prisma.chapterRevision.findFirst({
        where: {
          id: req.params.revisionId,
          chapterId: req.params.chapterId,
          chapter: { projectId: req.params.projectId },
        },
        select: { id: true },
      });
      if (!ok) return reply.status(404).send({ error: 'Revision not found' });
      await prisma.chapterRevision.delete({ where: { id: req.params.revisionId } });
      return reply.status(204).send();
    },
  );
};
