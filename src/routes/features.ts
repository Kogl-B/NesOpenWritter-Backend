import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { assertProjectOwnership } from '../lib/access.js';
import { generateEpub, generateDocx, generatePdf } from '../lib/exporters.js';

/**
 * v1.4-v3.0 — Дополнительные модули: знания, календарь, симулятор черт,
 * доска расследований, экспорт, совместная работа.
 */
export async function featureRoutes(app: FastifyInstance) {
  const checkProject = async (req: FastifyRequest<{ Params: { projectId: string } }>, reply: FastifyReply) => {
    app.requireAuth(req);
    if (!(await assertProjectOwnership(req.params.projectId, req.user!.id))) {
      reply.status(404).send({ error: 'Project not found' });
      return false;
    }
    return true;
  };

  // === v1.4: Туман войны ===
  app.get<{ Params: { projectId: string } }>(
    '/api/projects/:projectId/knowledge',
    async (req, reply) => {
      if (!(await checkProject(req, reply))) return;
      const entries = await prisma.knowledgeEntry.findMany({
        where: { projectId: req.params.projectId },
        include: { character: { select: { name: true } } },
      });
      return { entries };
    },
  );

  app.post<{ Params: { projectId: string } }>(
    '/api/projects/:projectId/knowledge',
    async (req, reply) => {
      if (!(await checkProject(req, reply))) return;
      const input = z.object({
        characterId: z.string(),
        topic: z.string().min(1).max(200),
        known: z.boolean().default(true),
        detail: z.string().max(1000).optional().nullable(),
        eventId: z.string().optional().nullable(),
      }).parse(req.body);
      const entry = await prisma.knowledgeEntry.upsert({
        where: { characterId_topic: { characterId: input.characterId, topic: input.topic } },
        update: { known: input.known, detail: input.detail },
        create: { ...input, projectId: req.params.projectId },
      });
      return reply.status(201).send({ entry });
    },
  );

  // === v1.5: Календарь ===
  app.get<{ Params: { projectId: string } }>(
    '/api/projects/:projectId/calendars',
    async (req, reply) => {
      if (!(await checkProject(req, reply))) return;
      const calendars = await prisma.calendar.findMany({
        where: { projectId: req.params.projectId },
      });
      return { calendars };
    },
  );

  app.post<{ Params: { projectId: string } }>(
    '/api/projects/:projectId/calendars',
    async (req, reply) => {
      if (!(await checkProject(req, reply))) return;
      const input = z.object({
        name: z.string().trim().min(1).max(100),
        monthsPerYear: z.number().int().min(1).max(24).default(12),
        daysPerMonth: z.number().int().min(1).max(60).default(30),
        moonCount: z.number().int().min(0).max(5).default(1),
        epochName: z.string().trim().max(50).default('Новая эра'),
        currentYear: z.number().int().default(1),
      }).parse(req.body);
      const calendar = await prisma.calendar.create({
        data: { ...input, projectId: req.params.projectId },
      });
      return reply.status(201).send({ calendar });
    },
  );

  app.patch<{ Params: { projectId: string; calendarId: string } }>(
    '/api/projects/:projectId/calendars/:calendarId',
    async (req, reply) => {
      if (!(await checkProject(req, reply))) return;
      const input = z.object({
        name: z.string().trim().min(1).max(100).optional(),
        monthsPerYear: z.number().int().min(1).max(24).optional(),
        daysPerMonth: z.number().int().min(1).max(60).optional(),
        moonCount: z.number().int().min(0).max(5).optional(),
        epochName: z.string().trim().max(50).optional(),
        currentYear: z.number().int().optional(),
        isDefault: z.boolean().optional(),
      }).parse(req.body);
      if (input.isDefault) {
        // основной календарь в проекте может быть только один
        await prisma.calendar.updateMany({
          where: { projectId: req.params.projectId },
          data: { isDefault: false },
        });
      }
      try {
        const calendar = await prisma.calendar.update({
          where: { id: req.params.calendarId },
          data: input,
        });
        return { calendar };
      } catch {
        return reply.status(404).send({ error: 'Календарь не найден' });
      }
    },
  );

  app.delete<{ Params: { projectId: string; calendarId: string } }>(
    '/api/projects/:projectId/calendars/:calendarId',
    async (req, reply) => {
      if (!(await checkProject(req, reply))) return;
      const result = await prisma.calendar.deleteMany({
        where: { id: req.params.calendarId, projectId: req.params.projectId },
      });
      if (result.count === 0) return reply.status(404).send({ error: 'Календарь не найден' });
      return reply.status(204).send();
    },
  );

  // === v1.6: Симулятор черт ===
  app.get<{ Params: { projectId: string } }>(
    '/api/projects/:projectId/traits',
    async (req, reply) => {
      if (!(await checkProject(req, reply))) return;
      const traits = await prisma.traitInheritance.findMany({
        where: { projectId: req.params.projectId },
      });
      return { traits };
    },
  );

  app.post<{ Params: { projectId: string } }>(
    '/api/projects/:projectId/traits',
    async (req, reply) => {
      if (!(await checkProject(req, reply))) return;
      const input = z.object({
        name: z.string().trim().min(1).max(100),
        type: z.enum(['physical', 'mental', 'magical', 'skill']).default('physical'),
        dominant: z.boolean().default(true),
        probability: z.number().min(0).max(1).default(0.5),
      }).parse(req.body);
      let trait;
      try {
        trait = await prisma.traitInheritance.create({
          data: { ...input, projectId: req.params.projectId },
        });
      } catch (err) {
        if ((err as { code?: string }).code === 'P2002') {
          return reply.status(409).send({ error: 'Черта с таким названием уже существует' });
        }
        throw err;
      }
      return reply.status(201).send({ trait });
    },
  );

  // === v1.7: Доска расследований ===
  app.get<{ Params: { projectId: string } }>(
    '/api/projects/:projectId/investigation',
    async (req, reply) => {
      if (!(await checkProject(req, reply))) return;
      const [pins, threads] = await Promise.all([
        prisma.investigationPin.findMany({ where: { projectId: req.params.projectId } }),
        prisma.investigationThread.findMany({
          where: { projectId: req.params.projectId },
          include: {
            fromPin: { select: { id: true, label: true, x: true, y: true } },
            toPin: { select: { id: true, label: true, x: true, y: true } },
          },
        }),
      ]);
      return { pins, threads };
    },
  );

  app.post<{ Params: { projectId: string } }>(
    '/api/projects/:projectId/investigation/pins',
    async (req, reply) => {
      if (!(await checkProject(req, reply))) return;
      const input = z.object({
        x: z.number(),
        y: z.number(),
        label: z.string().trim().min(1).max(200),
        note: z.string().max(1000).optional().nullable(),
        color: z.string().max(20).default('#f7bd48'),
        entityType: z.string().optional().nullable(),
        entityId: z.string().optional().nullable(),
      }).parse(req.body);
      const pin = await prisma.investigationPin.create({
        data: { ...input, projectId: req.params.projectId },
      });
      return reply.status(201).send({ pin });
    },
  );

  app.post<{ Params: { projectId: string } }>(
    '/api/projects/:projectId/investigation/threads',
    async (req, reply) => {
      if (!(await checkProject(req, reply))) return;
      const input = z.object({
        fromPinId: z.string(),
        toPinId: z.string(),
        label: z.string().max(100).optional().nullable(),
      }).parse(req.body);
      // Нить без пина в ответе ломает рендер доски — всегда включаем пины
      const thread = await prisma.investigationThread.create({
        data: { ...input, projectId: req.params.projectId },
        include: {
          fromPin: { select: { id: true, label: true, x: true, y: true } },
          toPin: { select: { id: true, label: true, x: true, y: true } },
        },
      });
      return reply.status(201).send({ thread });
    },
  );

  app.delete<{ Params: { projectId: string; pinId: string } }>(
    '/api/projects/:projectId/investigation/pins/:pinId',
    async (req, reply) => {
      if (!(await checkProject(req, reply))) return;
      try {
        // Нити ссылаются на пин: снимаем их первыми, иначе FK не даст удалить
        await prisma.investigationThread.deleteMany({
          where: { OR: [{ fromPinId: req.params.pinId }, { toPinId: req.params.pinId }] },
        });
        await prisma.investigationPin.delete({ where: { id: req.params.pinId } });
        return reply.status(204).send();
      } catch {
        return reply.status(404).send({ error: 'Пин не найден' });
      }
    },
  );

  // === v2.0: Экспорт ===
  app.post<{ Params: { projectId: string } }>(
    '/api/projects/:projectId/export',
    async (req, reply) => {
      if (!(await checkProject(req, reply))) return;
      const input = z.object({ format: z.enum(['json', 'markdown', 'txt', 'epub', 'docx', 'pdf']) }).parse(req.body);
      // Создаём job, сам экспорт синхронный (данные проекта)
      const [chars, items, locs, events, chapters, tags, maps] = await Promise.all([
        prisma.character.findMany({ where: { projectId: req.params.projectId } }),
        prisma.item.findMany({ where: { projectId: req.params.projectId } }),
        prisma.location.findMany({ where: { projectId: req.params.projectId } }),
        prisma.timelineEvent.findMany({ where: { projectId: req.params.projectId } }),
        prisma.chapter.findMany({ where: { projectId: req.params.projectId } }),
        prisma.tag.findMany({ where: { projectId: req.params.projectId } }),
        prisma.mapElement.findMany({ where: { projectId: req.params.projectId } }),
      ]);
      const project = await prisma.project.findUnique({
        where: { id: req.params.projectId },
        select: { name: true, description: true },
      });

      if (input.format === 'json') {
        return {
          project,
          characters: chars,
          items,
          locations: locs,
          events,
          chapters,
          tags,
          mapElements: maps,
          exportedAt: new Date().toISOString(),
        };
      }
      if (input.format === 'txt') {
        let txt = project?.name + '\n' + '='.repeat(project?.name.length ?? 7) + '\n\n';
        for (const c of chars) txt += c.name + (c.faction ? ' (' + c.faction + ')' : '') + '\n';
        txt += '\n--- ЛОКАЦИИ ---\n';
        for (const l of locs) txt += l.name + ' (' + l.kind + ')\n';
        txt += '\n--- СОБЫТИЯ ---\n';
        for (const e of events) txt += e.name + ' (' + e.at + ')\n';
        return reply.type('text/plain').send(txt);
      }
      if (input.format === 'epub') {
        const buf = generateEpub({
          projectName: project?.name ?? 'Project',
          chapters: chapters.map((c: { id: string; title: string; content: unknown; wordCount: number; kind: string }) => ({ id: c.id, title: c.title, content: c.content, wordCount: c.wordCount, kind: c.kind })),
          characters: chars,
          locations: locs,
        });
        return reply.type('application/epub+zip').send(buf);
      }
      if (input.format === 'docx') {
        const buf = generateDocx({
          projectName: project?.name ?? 'Project',
          chapters: chapters.map((c: { id: string; title: string; content: unknown; wordCount: number; kind: string }) => ({ id: c.id, title: c.title, content: c.content, wordCount: c.wordCount, kind: c.kind })),
          characters: chars,
          locations: locs,
        });
        return reply.type('application/vnd.openxmlformats-officedocument.wordprocessingml.document').send(buf);
      }
      if (input.format === 'pdf') {
        const buf = generatePdf({
          projectName: project?.name ?? 'Project',
          chapters: chapters.map((c: { id: string; title: string; content: unknown; wordCount: number; kind: string }) => ({ id: c.id, title: c.title, content: c.content, wordCount: c.wordCount, kind: c.kind })),
          characters: chars,
          locations: locs,
        });
        return reply.type('application/pdf').send(buf);
      }
      // markdown
      let md = `# ${project?.name ?? 'Project'}\n\n`;
      md += `## Персонажи (${chars.length})\n`;
      for (const c of chars) md += `- **${c.name}**${c.faction ? ` (${c.faction})` : ''}\n`;
      md += `\n## Предметы (${items.length})\n`;
      for (const i of items) md += `- **${i.name}** (${i.category})\n`;
      md += `\n## Локации (${locs.length})\n`;
      for (const l of locs) md += `- **${l.name}** (${l.kind})\n`;
      md += `\n## События (${events.length})\n`;
      for (const e of events) md += `- **${e.name}** (${e.at})\n`;
      return reply.type('text/markdown').send(md);
    },
  );

  // === v3.0: Совместная работа ===
  app.get<{ Params: { projectId: string } }>(
    '/api/projects/:projectId/collaborators',
    async (req, reply) => {
      if (!(await checkProject(req, reply))) return;
      const collaborators = await prisma.projectCollaborator.findMany({
        where: { projectId: req.params.projectId },
        include: { user: { select: { id: true, name: true, email: true } } },
      });
      return { collaborators };
    },
  );

  app.post<{ Params: { projectId: string } }>(
    '/api/projects/:projectId/collaborators',
    async (req, reply) => {
      if (!(await checkProject(req, reply))) return;
      const input = z.object({
        email: z.string().email(),
        role: z.enum(['viewer', 'editor', 'admin']).default('editor'),
      }).parse(req.body);
      const targetUser = await prisma.user.findUnique({ where: { email: input.email } });
      if (!targetUser) {
        return reply.status(404).send({ error: 'Пользователь с таким email не найден' });
      }
      if (targetUser.id === req.user!.id) {
        return reply.status(400).send({ error: 'Нельзя пригласить самого себя' });
      }
      const collab = await prisma.projectCollaborator.upsert({
        where: {
          projectId_userId: {
            projectId: req.params.projectId,
            userId: targetUser.id,
          },
        },
        update: { role: input.role, status: 'active' },
        create: {
          projectId: req.params.projectId,
          userId: targetUser.id,
          role: input.role,
          invitedById: req.user!.id,
        },
        include: { user: { select: { id: true, name: true, email: true } } },
      });
      return reply.status(201).send({ collaborator: collab });
    },
  );

  app.delete<{ Params: { projectId: string; collaboratorId: string } }>(
    '/api/projects/:projectId/collaborators/:collaboratorId',
    async (req, reply) => {
      if (!(await checkProject(req, reply))) return;
      try {
        await prisma.projectCollaborator.delete({
          where: { id: req.params.collaboratorId },
        });
        return reply.status(204).send();
      } catch {
        return reply.status(404).send({ error: 'Collaborator not found' });
      }
    },
  );

  // === Публичная ссылка (read-only) ===
  app.get<{ Params: { projectId: string } }>(
    '/api/public/:projectId/overview',
    async (req, reply) => {
      const project = await prisma.project.findUnique({
        where: { id: req.params.projectId },
        select: { name: true, description: true },
      });
      if (!project) return reply.status(404).send({ error: 'Not found' });
      const [chars, locs] = await Promise.all([
        prisma.character.findMany({
          where: { projectId: req.params.projectId },
          select: { name: true, faction: true, status: true },
        }),
        prisma.location.findMany({
          where: { projectId: req.params.projectId },
          select: { name: true, kind: true },
        }),
      ]);
      return { project, characters: chars, locations: locs };
    },
  );
}
