import type { FastifyPluginAsync } from 'fastify';

import { prisma } from '../lib/prisma.js';
import { toJson } from '../lib/access.js';
import { projectCreateSchema, projectUpdateSchema } from '../lib/schemas.js';

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
      projects: projects.map((p) => ({
        ...p,
        myRole: p.ownerId === req.user!.id ? 'owner' : roleByProject.get(p.id) ?? 'viewer',
      })),
    };
  });

  app.post('/api/projects', async (req, reply) => {
    const input = projectCreateSchema.parse(req.body);
    // Лимит Free-тарифа: до 3 проектов (env-перекрываем для тестов)
    const freeLimit = Number(process.env.FREE_PROJECT_LIMIT ?? 3);
    if (Number.isFinite(freeLimit) && freeLimit > 0) {
      const owned = await prisma.project.count({ where: { ownerId: req.user!.id } });
      if (owned >= freeLimit) {
        return reply.status(403).send({
          error: `Лимит бесплатного тарифа: до ${freeLimit} проектов. Удалите лишний проект или перейдите на Pro.`,
        });
      }
    }
    const project = await prisma.project.create({
      data: {
        ownerId: req.user!.id,
        name: input.name,
        description: input.description ?? null,
        settings: toJson(input.settings),
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
    return { project: { ...project, myRole } };
  });

  app.patch<{ Params: { id: string } }>('/api/projects/:id', async (req, reply) => {
    const input = projectUpdateSchema.parse(req.body);
    // settings — JSON-объект с независимыми разделами (автосейв, структура
    // истории и т.д.): мержим по ключам, чтобы один раздел не затирал другой
    let settingsPatch: Record<string, unknown> | undefined;
    if (input.settings !== undefined) {
      const existing = await prisma.project.findUnique({
        where: { id: req.params.id },
        select: { settings: true },
      });
      settingsPatch = {
        ...((existing?.settings as Record<string, unknown> | null) ?? {}),
        ...(input.settings as Record<string, unknown>),
      };
    }
    const result = await prisma.project.updateMany({
      where: { id: req.params.id, ownerId: req.user!.id },
      data: {
        ...(input.name !== undefined && { name: input.name }),
        ...(input.description !== undefined && { description: input.description }),
        ...(settingsPatch !== undefined && { settings: toJson(settingsPatch) }),
      },
    });
    if (result.count === 0) return reply.status(404).send({ error: 'Project not found' });
    const project = await prisma.project.findUnique({ where: { id: req.params.id } });
    return { project };
  });

  app.delete<{ Params: { id: string } }>('/api/projects/:id', async (req, reply) => {
    const result = await prisma.project.deleteMany({
      where: { id: req.params.id, ownerId: req.user!.id },
    });
    if (result.count === 0) return reply.status(404).send({ error: 'Project not found' });
    return reply.status(204).send();
  });
};
