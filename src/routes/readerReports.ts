import type { FastifyPluginAsync } from 'fastify';

import { prisma } from '../lib/prisma.js';
import { getProjectAccess } from '../lib/access.js';
import { readerReportCreateSchema } from '../lib/schemas.js';

function reportsEnabled(settings: unknown): boolean {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return true;
  return (settings as { readerReports?: unknown }).readerReports !== false;
}

export const readerReportRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', async (req) => {
    app.requireAuth(req);
  });

  app.post<{ Params: { projectId: string } }>('/api/projects/:projectId/reader-reports', async (req, reply) => {
    const role = await getProjectAccess(req.params.projectId, req.user!.id);
    if (!role) return reply.status(404).send({ error: 'Проект не найден' });
    const input = readerReportCreateSchema.parse(req.body);
    const project = await prisma.project.findUnique({
      where: { id: req.params.projectId },
      select: { ownerId: true },
    });
    if (!project) return reply.status(404).send({ error: 'Проект не найден' });
    const chapter = await prisma.chapter.findFirst({
      where: { id: input.chapterId, projectId: req.params.projectId },
      select: { id: true },
    });
    if (!chapter) return reply.status(404).send({ error: 'Сцена не найдена' });
    const report = await prisma.readerReport.create({
      data: {
        projectId: req.params.projectId,
        chapterId: chapter.id,
        authorId: project.ownerId,
        quote: input.quote,
        note: input.note ?? '',
      },
    });
    return reply.status(201).send({ report });
  });

  app.get('/api/me/reader-reports', async (req) => {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.id },
      select: { settings: true },
    });
    const enabled = reportsEnabled(user?.settings);
    if (!enabled) return { enabled: false, reports: [] };
    const reports = await prisma.readerReport.findMany({
      where: { authorId: req.user!.id },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return { enabled: true, reports };
  });
};
