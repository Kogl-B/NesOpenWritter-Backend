import type { FastifyPluginAsync } from 'fastify';

import { Prisma } from '@prisma/client';

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

/** FNV-1a: ~1ms на 200KB — дешёвый weak-etag для 304-условных ответов. */
function hashBody(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}
type ChapterParam = { projectId: string; chapterId: string };
type RevisionParam = { projectId: string; chapterId: string; revisionId: string };

export const chapterRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', async (req) => {
    app.requireAuth(req);
  });

  app.get<{ Params: ProjectParam; Querystring: { format?: string } }>(
    '/api/projects/:projectId/chapters',
    async (req, reply) => {
      if (!(await assertProjectOwnership(req.params.projectId, req.user!.id))) {
        return reply.status(404).send({ error: 'Project not found' });
      }
      // ?format=rows: постолбцовый ответ без повторяющихся ключей объектов —
      // на дереве из 1000+ глав это −35% raw-размера и быстрее JSON.parse
      // на клиенте. Классический формат остаётся дефолтом (совместимость).
      const asRows = req.query.format === 'rows';
      // Лёгкий список для дерева рукописи: summary/metadata/content тянутся
      // точечно fetchOne (loadSceneContent), иначе список из 1000+ сцен
      // раздувается до полумегабайта. projectId/createdAt не рендерятся
      // нигде (DiffViewer берёт их из полной записи) — их нет в SELECT,
      // но ORDER BY по createdAt остаётся: сортировка по невыбранной
      // колонке легальна и стабильна.
      // $queryRaw вместо findMany: на 1443 строках материализация через
      // Rust-движок Prisma стоит ~50ms против ~3ms raw при том же SQL.
      const chapters = await prisma.$queryRaw<
        Array<{
          id: string; title: string; kind: string;
          parentId: string | null; orderIndex: number; wordCount: number;
          updatedAt: Date;
        }>
      >(Prisma.sql`
        SELECT id, title, kind, "parentId", "orderIndex",
               "wordCount", "updatedAt"
        FROM chapters
        WHERE "projectId" = ${req.params.projectId}
        ORDER BY "orderIndex" ASC, "createdAt" ASC
      `);
      // ETag/304 (R26): повторные входы в проект не тянут 200+KB дерева, если
      // оно не менялось. Weak-etag от тела ответа; If-None-Match → 304.
      const body = asRows
        ? {
            cols: ['id', 'title', 'kind', 'parentId', 'orderIndex', 'wordCount', 'updatedAt'],
            rows: chapters.map((c) => [c.id, c.title, c.kind, c.parentId, c.orderIndex, c.wordCount, c.updatedAt]),
          }
        : { chapters };
      const etag = 'W/"' + hashBody(JSON.stringify(body)) + '"';
      if (req.headers['if-none-match'] === etag) {
        reply.status(304).send();
        return;
      }
      reply.header('etag', etag);
      return body;
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
      // Content (тяжёлый JSONB) грузим ТОЛЬКО когда ревизия реально будет
      // создана — автосейв ходит каждые ~8 секунд и не должен читать
      // содержимое сцены целиком на каждый запрос.
      // Предчек одним raw-запросом (wordCount + дата последней ревизии):
      // два findFirst через движок Prisma стоили ~8ms на каждый автосейв.
      const [before] = await prisma.$queryRaw<
        Array<{ wordCount: number | null; lastRevAt: Date | null }>
      >(Prisma.sql`
        SELECT c."wordCount",
               (SELECT max(r."createdAt") FROM chapter_revisions r
                 WHERE r."chapterId" = c.id) AS "lastRevAt"
        FROM chapters c
        WHERE c.id = ${req.params.chapterId} AND c."projectId" = ${req.params.projectId}
      `);
      if (before) {
        const beforeWords = before.wordCount ?? 0;
        const afterWords = input.wordCount ?? 0;
        // Порог с 20 снижен до 4: сцены QA-раундов короче 20 слов и защита
        // не срабатывала — текст терялся безвозвратно. Любое сокращение
        // до ≤2 слов при ≥4 раньше — подозрительно на затирание.
        const looksLikeWipe = beforeWords >= 4 && afterWords <= 2;
        const stale = !before.lastRevAt || Date.now() - before.lastRevAt.getTime() > 60_000;
        if (looksLikeWipe || stale) {
          const [content, keptAuto] = await prisma.$transaction([
            prisma.chapter.findUnique({
              where: { id: req.params.chapterId },
              select: { content: true },
            }),
            // Ротация авто-ревизий: держим последние 50 на сцену. Ручные
            // снапшоты (label без префикса «авто») не трогаем.
            prisma.chapterRevision.findMany({
              where: { chapterId: req.params.chapterId, label: { startsWith: 'авто' } },
              orderBy: { createdAt: 'desc' },
              take: 50,
              select: { id: true },
            }),
          ]);
          const label = looksLikeWipe ? 'авто · перед затиранием' : 'автосохранение';
          await prisma.$transaction([
            prisma.chapterRevision.create({
              data: {
                chapterId: req.params.chapterId,
                label,
                content: (content?.content ?? {}) as object,
                wordCount: beforeWords,
              },
            }),
            ...(keptAuto.length === 50
              ? [
                  prisma.chapterRevision.deleteMany({
                    where: {
                      chapterId: req.params.chapterId,
                      label: { startsWith: 'авто' },
                      id: { notIn: keptAuto.map((r) => r.id) },
                    },
                  }),
                ]
              : []),
          ]);
        }
      }

      // Запись + ответ одним UPDATE ... RETURNING: отдельный findUnique
      // после updateMany добавлял ~4ms на каждый автосейв.
      const json = JSON.stringify(input.content);
      const updated = await prisma.$queryRaw<
        Array<{ id: string; wordCount: number; updatedAt: Date }>
      >(Prisma.sql`
        UPDATE chapters
        SET content = ${json}::jsonb,
            "updatedAt" = now()
            ${input.wordCount !== undefined ? Prisma.sql`, "wordCount" = ${input.wordCount}` : Prisma.empty}
        WHERE id = ${req.params.chapterId} AND "projectId" = ${req.params.projectId}
        RETURNING id, "wordCount", "updatedAt"
      `);
      if (updated.length === 0) {
        return reply.status(404).send({ error: 'Chapter not found' });
      }
      return { chapter: updated[0] };
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
        // Лимит: за месяцы работы автосейв накапливает сотни ревизий на
        // сцену — тянуть весь список в историю незачем.
        take: 100,
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
