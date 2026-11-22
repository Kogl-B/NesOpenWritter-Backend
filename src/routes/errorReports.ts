import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import { requireAdmin } from '../lib/accountStatus.js';
import { prisma } from '../lib/prisma.js';

const createSchema = z.object({
  message: z.string().trim().min(8).max(2000),
  page: z.string().trim().max(300).optional(),
});

const statusSchema = z.object({
  status: z.enum(['new', 'seen', 'approved', 'rejected']),
});

export const errorReportRoutes: FastifyPluginAsync = async (app) => {
  app.post('/api/error-reports', async (req, reply) => {
    app.requireAuth(req);
    const input = createSchema.parse(req.body);
    const last = await prisma.appErrorReport.findFirst({
      where: { userId: req.user!.id },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
    if (last && Date.now() - last.createdAt.getTime() < 20_000) {
      return reply.status(429).send({ error: 'Подождите немного перед следующим сообщением' });
    }
    const report = await prisma.appErrorReport.create({
      data: {
        userId: req.user!.id,
        message: input.message,
        page: input.page ?? '',
      },
      select: { id: true },
    });
    return reply.status(201).send({ report });
  });

  app.get('/api/admin/error-reports', async (req, reply) => {
    if (!(await requireAdmin(app, req, reply))) return;
    const reports = await prisma.appErrorReport.findMany({
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: { user: { select: { id: true, email: true, name: true } } },
    });
    return { reports };
  });

  app.patch<{ Params: { id: string } }>('/api/admin/error-reports/:id', async (req, reply) => {
    if (!(await requireAdmin(app, req, reply))) return;
    const input = statusSchema.parse(req.body);
    const existing = await prisma.appErrorReport.findUnique({ where: { id: req.params.id }, select: { id: true } });
    if (!existing) return reply.status(404).send({ error: 'Сообщение не найдено' });
    await prisma.appErrorReport.update({ where: { id: existing.id }, data: { status: input.status } });
    return { ok: true as const };
  });

  app.delete<{ Params: { id: string } }>('/api/admin/error-reports/:id', async (req, reply) => {
    if (!(await requireAdmin(app, req, reply))) return;
    const existing = await prisma.appErrorReport.findUnique({ where: { id: req.params.id }, select: { id: true } });
    if (!existing) return reply.status(404).send({ error: 'Сообщение не найдено' });
    await prisma.appErrorReport.delete({ where: { id: existing.id } });
    return { ok: true as const };
  });
};
