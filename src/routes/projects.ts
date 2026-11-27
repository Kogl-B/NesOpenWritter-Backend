import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import { prisma } from '../lib/prisma.js';
import { catalogCyclePatch } from '../lib/bookCycles.js';
import { getUserPlan } from './account.js';
import { getTier } from '../lib/tiers.js';
import { getProjectAccess, toJson } from '../lib/access.js';
import { timelineSettingsSchema, validTimelineStart } from '../lib/timeline/date.js';
import { mergeWorldTablePhotos } from '../lib/ai/place.js';
import { projectCreateSchema, projectUpdateSchema } from '../lib/schemas.js';
import { bookStatusNotices } from '../lib/notify/drafts.js';
import { writeNotices } from '../lib/notify/deliver.js';
import { directoryCard, directoryLocation } from '../lib/worldDirectory.js';
import { applyWorldCellChanges, applyWorldReaderRules, applyWorldTableChanges, preserveWorldReaderRules } from '../lib/worldTableChanges.js';
import { withoutPrivateWorldData, readWorldInbox, worldNoteInput } from '../lib/worldInbox.js';
import { factInput, objectOf, readWorldFacts, updateFact } from '../lib/worldFacts.js';
import { chapterBlocks } from '../lib/publish/text.js';
import { xlsxWorkbook } from '../lib/xlsx.js';

const worldExport = z.object({
  sheets: z.array(z.object({
    name: z.string().trim().min(1).max(80),
    rows: z.array(z.array(z.union([z.string().max(8000), z.number().finite()])).min(1).max(24)).min(1).max(501),
  })).min(1).max(40),
});

const worldTableId = z.string().min(1).max(200);
const worldTableChanges = z.object({
  upsert: z.array(z.object({ id: worldTableId }).passthrough()).max(40),
  remove: z.array(worldTableId).max(40),
  cells: z.array(z.object({
    tableId: worldTableId, rowId: worldTableId, columnId: worldTableId,
    kind: z.enum(['text', 'date', 'datetime', 'number', 'checkbox', 'select', 'character', 'place', 'item']),
    value: z.string().max(8000),
  })).max(512).default([]),
  readerRules: z.array(z.object({
    tableId: worldTableId, rowId: worldTableId, columnId: worldTableId,
    rule: z.string().regex(/^[A-Za-z0-9_-]{0,40}$/),
  })).max(960).default([]),
}).superRefine(({ upsert, remove, cells, readerRules }, ctx) => {
  const ids = [...upsert.map((item) => item.id), ...remove];
  const changedTables = new Set(ids);
  if (changedTables.size !== ids.length || cells.some(({ tableId }) => changedTables.has(tableId))) {
    ctx.addIssue({ code: 'custom', message: 'Таблица указана дважды' });
  }
  const keys = cells.map(({ tableId, rowId, columnId }) => JSON.stringify([tableId, rowId, columnId]));
  if (new Set(keys).size !== keys.length) ctx.addIssue({ code: 'custom', message: 'Ячейка указана дважды' });
  const ruleKeys = readerRules.map(({ tableId, rowId, columnId }) => JSON.stringify([tableId, rowId, columnId]));
  if (new Set(ruleKeys).size !== ruleKeys.length || readerRules.some(({ tableId }) => remove.includes(tableId))) {
    ctx.addIssue({ code: 'custom', message: 'Некорректный список правил видимости' });
  }
});

export const projectRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', async (req) => {
    app.requireAuth(req);
  });

  app.get('/api/projects', async (req) => {
    // собственные + проекты, куда пользователя пригласили коллаборатором
    const projects = await prisma.project.findMany({
      where: {
        OR: [
          { ownerId: req.user!.id },
          { ProjectCollaborator: { some: { userId: req.user!.id, status: 'active' } } },
        ],
      },
      orderBy: { updatedAt: 'desc' },
    });
    // роль текущего пользователя в каждом проекте (для read-only режима Читателя)
    const collabs = await prisma.projectCollaborator.findMany({
      where: { userId: req.user!.id, status: 'active', projectId: { in: projects.map((p) => p.id) } },
      select: { projectId: true, role: true },
    });
    const roleByProject = new Map(collabs.map((c) => [c.projectId, c.role]));
    return {
      projects: projects.map((p) => {
        const myRole = p.ownerId === req.user!.id ? 'owner' : roleByProject.get(p.id) ?? 'viewer';
        return { ...p, myRole, settings: withoutPrivateWorldData(p.settings) };
      }),
    };
  });

  app.post('/api/projects', async (req, reply) => {
    const input = projectCreateSchema.parse(req.body);
    if (input.settings?.timelineAnalysis !== undefined) {
      const chronology = timelineSettingsSchema.parse(input.settings.timelineAnalysis);
      if (chronology.calendarId) return reply.status(400).send({ error: 'Сначала создайте календарь в книге.' });
      input.settings.timelineAnalysis = chronology;
    }
    // Лимит проектов по тарифу подписки пользователя (tiers.ts); null = безлимит
    const tier = getTier(await getUserPlan(req.user!.id));
    if (tier.projectLimit != null) {
      const owned = await prisma.project.count({ where: { ownerId: req.user!.id } });
      if (owned >= tier.projectLimit) {
        return reply.status(403).send({
          error: `Достигнут лимит тарифа «${tier.name}»: ${tier.projectLimit} проектов. Освободите слот (удалите проект) или смените тариф в личном кабинете.`,
        });
      }
    }
    const project = await prisma.project.create({
      data: {
        ownerId: req.user!.id,
        name: input.name,
        description: input.description ?? null,
        settings: toJson(withoutPrivateWorldData(input.settings) as Record<string, unknown> | undefined),
      },
    });
    return reply.status(201).send({ project });
  });

  app.get<{ Params: { id: string } }>('/api/projects/:id', async (req, reply) => {
    const project = await prisma.project.findFirst({
      where: {
        id: req.params.id,
        OR: [
          { ownerId: req.user!.id },
          { ProjectCollaborator: { some: { userId: req.user!.id, status: 'active' } } },
        ],
      },
    });
    if (!project) return reply.status(404).send({ error: 'Project not found' });
    // роль текущего пользователя (для read-only режима Читателя)
    const myRole = project.ownerId === req.user!.id
      ? 'owner'
      : (await prisma.projectCollaborator.findFirst({
          where: { projectId: project.id, userId: req.user!.id, status: 'active' },
          select: { role: true },
        }))?.role ?? 'viewer';
    return { project: { ...project, myRole, settings: withoutPrivateWorldData(project.settings) } };
  });

  app.get<{ Params: { id: string } }>('/api/projects/:id/manuscript-directory', async (req, reply) => {
    const { id } = req.params;
    reply.header('Cache-Control', 'private, no-store');
    if (!await getProjectAccess(id, req.user!.id)) return reply.status(404).send({ error: 'Справочная запись недоступна.' });
    const input = directoryLocation.parse(req.query);
    const project = await prisma.project.findUnique({ where: { id }, select: { settings: true } });
    const card = project && await directoryCard(id, project.settings, input);
    if (!card) return reply.status(404).send({ error: 'Справочная запись недоступна.' });
    return { card };
  });

  app.get<{ Params: { id: string } }>('/api/projects/:id/world-inbox', async (req, reply) => {
    const { id } = req.params;
    const role = await getProjectAccess(id, req.user!.id);
    if (!role || role === 'viewer') return reply.status(404).send({ error: 'Заметки недоступны' });
    const [row] = await prisma.$queryRaw<Array<{ notes: unknown }>>`
      SELECT settings->'worldInbox' AS notes FROM projects WHERE id = ${id}
    `;
    return { notes: readWorldInbox(row?.notes) };
  });

  app.put<{ Params: { id: string; noteId: string } }>('/api/projects/:id/world-inbox/:noteId', async (req, reply) => {
    const { id } = req.params;
    const noteId = z.string().uuid().parse(req.params.noteId);
    const role = await getProjectAccess(id, req.user!.id);
    if (!role || role === 'viewer') return reply.status(404).send({ error: 'Заметки недоступны' });
    const input = z.union([z.object({ done: z.boolean() }).strict(), worldNoteInput]).parse(req.body);
    if ('id' in input && input.id !== noteId) return reply.status(400).send({ error: 'Неверный номер заметки' });
    const result = await prisma.$transaction(async (tx) => {
      const [row] = await tx.$queryRaw<Array<{ notes: unknown }>>`
        SELECT settings->'worldInbox' AS notes FROM projects WHERE id = ${id} FOR UPDATE
      `;
      if (!row) return null;
      const notes = readWorldInbox(row.notes);
      const previous = notes.find((note) => note.id === noteId);
      if ('id' in input && previous) return { note: previous };
      if ('done' in input && !previous) return null;
      if ('id' in input && notes.length >= 300) return { limit: true };
      if ('id' in input && !await tx.chapter.findFirst({
        where: { id: input.unitId, projectId: id }, select: { id: true },
      })) return null;
      const note = 'done' in input
        ? { ...previous!, done: input.done }
        : { ...input, done: false, createdAt: new Date().toISOString() };
      const next = previous ? notes.map((entry) => entry.id === noteId ? note : entry) : [note, ...notes];
      await tx.$executeRaw`
        UPDATE projects SET settings = jsonb_set(
          CASE WHEN jsonb_typeof(settings) = 'object' THEN settings ELSE '{}'::jsonb END,
          '{worldInbox}', ${JSON.stringify(next)}::jsonb
        ) WHERE id = ${id}
      `;
      return { note };
    });
    if (!result) return reply.status(404).send({ error: 'Заметка или исходная глава недоступна' });
    if ('limit' in result) return reply.status(409).send({ error: 'Достигнут лимит заметок проекта' });
    return result;
  });

  app.get<{ Params: { id: string } }>('/api/projects/:id/world-facts', async (req, reply) => {
    const { id } = req.params;
    const role = await getProjectAccess(id, req.user!.id);
    if (!role || role === 'viewer') return reply.status(404).send({ error: 'Факты недоступны' });
    reply.header('Cache-Control', 'private, no-store');
    const [row] = await prisma.$queryRaw<Array<{ facts: unknown }>>`
      SELECT settings->'worldFacts' AS facts FROM projects WHERE id = ${id}
    `;
    return { facts: readWorldFacts(row?.facts) };
  });

  app.put<{ Params: { id: string; factId: string } }>('/api/projects/:id/world-facts/:factId', async (req, reply) => {
    const { id } = req.params;
    const factId = z.string().uuid().parse(req.params.factId);
    const userId = req.user!.id;
    const role = await getProjectAccess(id, userId);
    if (!role || role === 'viewer') return reply.status(404).send({ error: 'Факты недоступны' });
    const input = factInput.parse(req.body);
    const result = await prisma.$transaction(async (tx) => {
      const [row] = await tx.$queryRaw<Array<{ facts: unknown; tables: unknown }>>`
        SELECT settings->'worldFacts' AS facts, settings->'worldTables' AS tables FROM projects WHERE id = ${id} FOR UPDATE
      `;
      if (!row) return { issue: 'Книга недоступна' };
      const facts = readWorldFacts(row.facts);
      const current = facts.find((entry) => entry.id === factId);
      const next = updateFact(current, factId, input, userId, new Date().toISOString());
      if (!next.changed) return next;
      if (!current && facts.length >= 300) return { issue: 'Достигнут лимит фактов книги' };
      if (input.source) {
        const unit = await tx.chapter.findFirst({
          where: { id: input.source.unitId, projectId: id }, select: { content: true },
        });
        const plain = (value: string) => value.replace(/\s+/g, ' ').trim();
        const text = typeof unit?.content === 'string' ? unit.content : chapterBlocks(unit?.content).join(' ');
        if (!unit || !plain(text).includes(plain(input.source.quote))) {
          return { issue: 'Цитата отсутствует в сохранённом тексте главы или сцены. Сохраните рукопись и проверьте цитату.' };
        }
      }
      if (input.eventId && !await tx.timelineEvent.findFirst({
        where: { id: input.eventId, projectId: id }, select: { id: true },
      })) return { issue: 'Событие хронологии недоступно' };
      if (!current && input.subject) {
        const entity = input.subject;
        const where = { id: entity.id ?? '', projectId: id };
        let exists = entity.kind === 'other';
        if (entity.kind === 'character') exists = Boolean(await tx.character.findFirst({ where, select: { id: true } }));
        if (entity.kind === 'place') exists = Boolean(await tx.location.findFirst({ where, select: { id: true } }));
        if (entity.kind === 'item') exists = Boolean(await tx.item.findFirst({ where, select: { id: true } }));
        if (entity.kind === 'row' && Array.isArray(row.tables)) {
          const table = row.tables.map(objectOf).find((entry) => entry.id === entity.tableId);
          exists = Array.isArray(table?.rows) && table.rows.some((entry) => objectOf(entry).id === entity.id);
        }
        if (!exists) return { issue: 'Карточка факта недоступна' };
      }
      const entries = current ? facts.map((entry) => entry.id === factId ? next.fact : entry) : [next.fact, ...facts];
      await tx.$executeRaw`
        UPDATE projects SET settings = jsonb_set(
          CASE WHEN jsonb_typeof(settings) = 'object' THEN settings ELSE '{}'::jsonb END,
          '{worldFacts}', ${JSON.stringify(entries)}::jsonb
        ) WHERE id = ${id}
      `;
      return next;
    });
    return 'issue' in result ? reply.status(409).send({ error: result.issue }) : { fact: result.fact };
  });

  app.get<{ Params: { id: string }; Querystring: { since?: string } }>(
    '/api/projects/:id/world-tables', async (req, reply) => {
      const id = req.params.id;
      if (!await getProjectAccess(id, req.user!.id)) {
        return reply.status(404).send({ error: 'Проект недоступен' });
      }
      const since = req.query.since ? new Date(req.query.since) : null;
      const version = since && Number.isFinite(since.getTime()) ? since : null;
      const [row] = await prisma.$queryRaw<Array<{ tables: unknown; updatedAt: Date }>>`
        SELECT CASE WHEN "updatedAt" = ${version} THEN NULL ELSE COALESCE(settings->'worldTables', '[]'::jsonb) END AS tables,
               "updatedAt"
        FROM projects WHERE id = ${id}
      `;
      if (!row) return reply.status(404).send({ error: 'Проект недоступен' });
      return row;
    },
  );

  app.patch<{ Params: { id: string } }>(
    '/api/projects/:id/world-tables', { bodyLimit: 32 * 1024 * 1024 }, async (req, reply) => {
      const id = req.params.id;
      const userId = req.user!.id;
      const changes = worldTableChanges.parse(req.body);
      const result = await prisma.$transaction(async (tx) => {
        const [row] = await tx.$queryRaw<Array<{ tables: unknown }>>`
          SELECT settings->'worldTables' AS tables FROM projects
          WHERE id = ${id} AND "ownerId" = ${userId} FOR UPDATE
        `;
        if (!row) return null;
        const { tables, upsert } = applyWorldTableChanges(row.tables, changes);
        if (tables.length > Math.max(40, Array.isArray(row.tables) ? row.tables.length : 0)) {
          return { issue: 'В проекте уже 40 таблиц' } as const;
        }
        const editedCells = applyWorldCellChanges(tables, changes.cells);
        if (!editedCells) return { issue: 'Строка или столбец изменились. Обновите таблицу перед сохранением.' } as const;
        const reveals = [...new Set(changes.readerRules.map(({ rule }) => rule).filter((rule) => rule && rule !== 'private'))];
        if (reveals.length && reveals.length !== await tx.chapter.count({
          where: { projectId: id, kind: 'chapter', id: { in: reveals } },
        })) return { issue: 'Глава для раскрытия поля недоступна.' } as const;
        const updated = applyWorldReaderRules(editedCells, changes.readerRules);
        if (!updated) return { issue: 'Строка или столбец изменились. Обновите таблицу перед сохранением.' } as const;
        await tx.$executeRaw`
          UPDATE projects
          SET settings = jsonb_set(
            CASE WHEN jsonb_typeof(settings) = 'object' THEN settings ELSE '{}'::jsonb END,
            '{worldTables}', ${JSON.stringify(updated)}::jsonb
          ), "updatedAt" = NOW()
          WHERE id = ${id}
        `;
        const ids = new Set(upsert.map((table) => table.id));
        return { upsert: updated.filter((table) => table && typeof table === 'object' && ids.has((table as { id: string }).id)) };
      });
      if (!result) return reply.status(404).send({ error: 'Проект недоступен' });
      if ('issue' in result) return reply.status(409).send({ error: result.issue });
      return result;
    },
  );

  app.post<{ Params: { id: string } }>('/api/projects/:id/world-tables/export', { bodyLimit: 32 * 1024 * 1024 }, async (req, reply) => {
    if (!await getProjectAccess(req.params.id, req.user!.id)) {
      return reply.status(404).send({ error: 'Проект недоступен' });
    }
    const { sheets } = worldExport.parse(req.body);
    return reply
      .header('Cache-Control', 'private, no-store')
      .type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .send(xlsxWorkbook(sheets));
  });

  app.patch<{ Params: { id: string } }>('/api/projects/:id', async (req, reply) => {
    const input = projectUpdateSchema.parse(req.body);
    if (input.settings?.timelineAnalysis !== undefined) {
      const chronology = timelineSettingsSchema.parse(input.settings.timelineAnalysis);
      if (chronology.calendarId) {
        const calendar = await prisma.calendar.findFirst({
          where: { id: chronology.calendarId, projectId: req.params.id },
          select: { monthsPerYear: true, daysPerMonth: true, settings: true },
        });
        if (!calendar || !validTimelineStart(chronology.start, calendar)) {
          return reply.status(400).send({ error: 'Дата начала не подходит к выбранному календарю книги.' });
        }
      }
      input.settings.timelineAnalysis = chronology;
    }
    // settings — JSON-объект с независимыми разделами (автосейв, структура
    // истории и т.д.): мержим по ключам, чтобы один раздел не затирал другой
    if (input.settings !== undefined) {
      const catalog = input.settings.catalog && typeof input.settings.catalog === 'object' && !Array.isArray(input.settings.catalog)
        ? catalogCyclePatch.parse(input.settings.catalog) : undefined;
      const locked = await prisma.$transaction(async (tx) => {
        if (catalog) {
          await tx.$queryRaw`SELECT id FROM users WHERE id = ${req.user!.id} FOR UPDATE`;
        }
        const rows = await tx.$queryRaw<Array<{ settings: unknown }>>`
          SELECT settings FROM projects WHERE id = ${req.params.id} AND "ownerId" = ${req.user!.id} FOR UPDATE
        `;
        const row = rows[0];
        if (!row) return null;
        const previous = catalogStatus(row.settings);
        const base = row.settings && typeof row.settings === 'object' && !Array.isArray(row.settings)
          ? row.settings as Record<string, unknown>
          : {};
        const incoming = withoutPrivateWorldData(input.settings) as Record<string, unknown>;
        const patch: Record<string, unknown> = { ...base, ...incoming };
        if (catalog) {
          const old = base.catalog && typeof base.catalog === 'object' && !Array.isArray(base.catalog)
            ? base.catalog as Record<string, unknown> : {};
          const previousName = typeof old.cycle === 'string' ? old.cycle.trim() : '';
          const name = typeof catalog.cycle === 'string' ? catalog.cycle.trim() : previousName;
          const next = { ...old, ...catalog, cycle: name };
          if (!name || name !== previousName) {
            next.cycleOrder = name ? catalog.cycleOrder ?? null : null;
            next.cycleBranch = name ? catalog.cycleBranch ?? '' : '';
            next.cycleEntry = Boolean(name && catalog.cycleEntry);
          }
          patch.catalog = next;
          if (name && next.cycleEntry === true) {
            await tx.$executeRaw`
              UPDATE projects SET settings = jsonb_set(settings, '{catalog,cycleEntry}', 'false'::jsonb)
              WHERE "ownerId" = ${req.user!.id} AND id <> ${req.params.id}
                AND btrim(settings #>> '{catalog,cycle}') = ${name}
                AND settings #> '{catalog,cycleEntry}' = 'true'::jsonb
            `;
          }
        }
        if ('worldTables' in incoming) {
          patch.worldTables = preserveWorldReaderRules(base.worldTables, mergeWorldTablePhotos(base.worldTables, incoming.worldTables));
        }
        const project = await tx.project.update({
          where: { id: req.params.id },
          data: {
            ...(input.name !== undefined && { name: input.name }),
            ...(input.description !== undefined && { description: input.description }),
            settings: toJson(patch),
          },
        });
        return { project, previous, patch };
      });
      if (!locked) return reply.status(404).send({ error: 'Project not found' });
      const nextStatus = catalogStatus(locked.patch);
      if ((nextStatus === 'complete' || nextStatus === 'frozen') && nextStatus !== locked.previous) {
        const subs = await prisma.bookSubscription.findMany({
          where: { projectId: locked.project.id, userId: { not: req.user!.id } },
          select: { userId: true },
        });
        await writeNotices(bookStatusNotices({
          actorId: req.user!.id,
          subscriberIds: subs.map((row) => row.userId),
          projectId: locked.project.id,
          bookTitle: locked.project.name,
          status: nextStatus,
        }));
      }
      return { project: { ...locked.project, settings: withoutPrivateWorldData(locked.project.settings) } };
    }
    const result = await prisma.project.updateMany({
      where: { id: req.params.id, ownerId: req.user!.id },
      data: {
        ...(input.name !== undefined && { name: input.name }),
        ...(input.description !== undefined && { description: input.description }),
      },
    });
    if (result.count === 0) return reply.status(404).send({ error: 'Project not found' });
    const project = await prisma.project.findUnique({ where: { id: req.params.id } });
    return { project: project && { ...project, settings: withoutPrivateWorldData(project.settings) } };
  });

  app.delete<{ Params: { id: string } }>('/api/projects/:id', async (req, reply) => {
    const result = await prisma.project.deleteMany({
      where: { id: req.params.id, ownerId: req.user!.id },
    });
    if (result.count === 0) return reply.status(404).send({ error: 'Project not found' });
    return reply.status(204).send();
  });
};

function catalogStatus(settings: unknown): 'writing' | 'complete' | 'frozen' {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return 'writing';
  const catalog = (settings as { catalog?: unknown }).catalog;
  if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)) return 'writing';
  const status = (catalog as { status?: unknown }).status;
  return status === 'complete' || status === 'frozen' ? status : 'writing';
}
