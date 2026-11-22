import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import { toJson } from '../lib/access.js';
import { prisma } from '../lib/prisma.js';
import { mergeNoticeSettings, NOTICE_KINDS, noticePrefs } from '../lib/notify/drafts.js';

const kindSchema = z.enum(NOTICE_KINDS);
const settingsSchema = z.object({
  chapter: z.boolean().optional(),
  book_comment: z.boolean().optional(),
  comment_reply: z.boolean().optional(),
  blog_post: z.boolean().optional(),
  blog_comment: z.boolean().optional(),
  reader_report: z.boolean().optional(),
}).refine((row) => Object.values(row).some((value) => value !== undefined), 'Нечего сохранять');

const readSchema = z.object({
  all: z.boolean().optional(),
  ids: z.array(z.string().min(1).max(64)).max(100).optional(),
}).refine((row) => row.all === true || (row.ids?.length ?? 0) > 0, 'Укажите уведомления');

export const notificationRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', async (req) => {
    app.requireAuth(req);
  });

  app.get('/api/notifications', async (req) => {
    const parsed = z.object({ kind: kindSchema.optional() }).safeParse(req.query);
    const kind = parsed.success ? parsed.data.kind : undefined;
    const where = { userId: req.user!.id, ...(kind ? { kind } : {}) };
    const [rows, unread] = await Promise.all([
      prisma.notification.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: 60,
      }),
      prisma.notification.count({ where: { userId: req.user!.id, readAt: null } }),
    ]);
    return {
      unread,
      notices: rows.map((row) => ({
        id: row.id,
        kind: row.kind,
        title: row.title,
        body: row.body,
        href: row.href.startsWith('/') && !row.href.startsWith('//') ? row.href : '/account?section=notices',
        read: row.readAt != null,
        createdAt: row.createdAt.toISOString(),
      })),
    };
  });

  app.get('/api/notifications/unread', async (req) => {
    const unread = await prisma.notification.count({
      where: { userId: req.user!.id, readAt: null },
    });
    return { unread };
  });

  app.get('/api/notifications/settings', async (req) => {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.id },
      select: { settings: true },
    });
    return { notices: noticePrefs(user?.settings) };
  });

  app.patch('/api/notifications/settings', async (req) => {
    const patch = settingsSchema.parse(req.body);
    const user = await prisma.user.findUnique({
      where: { id: req.user!.id },
      select: { settings: true },
    });
    const settings = mergeNoticeSettings(user?.settings, patch);
    await prisma.user.update({
      where: { id: req.user!.id },
      data: { settings: toJson(settings) },
    });
    return { notices: noticePrefs(settings) };
  });

  app.post('/api/notifications/read', async (req) => {
    const input = readSchema.parse(req.body);
    await prisma.notification.updateMany({
      where: {
        userId: req.user!.id,
        readAt: null,
        ...(input.all ? {} : { id: { in: input.ids ?? [] } }),
      },
      data: { readAt: new Date() },
    });
    const unread = await prisma.notification.count({
      where: { userId: req.user!.id, readAt: null },
    });
    return { unread };
  });
};
