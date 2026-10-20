import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import { prisma } from '../lib/prisma.js';
import { toJson } from '../lib/access.js';
import { userSettingsUpdateSchema } from '../lib/schemas.js';

const profileSchema = z.object({
  name: z.string().trim().min(1).max(80),
});

function avatarOk(value: unknown): boolean {
  return value == null || (typeof value === 'string' && (value === '' || (value.startsWith('data:image/') && value.length <= 220_000)));
}

export const meRoutes: FastifyPluginAsync = async (app) => {
  app.get('/api/me', async (req, reply) => {
    app.requireAuth(req);
    const settings = await prisma.user.findUnique({
      where: { id: req.user!.id },
      select: { settings: true, plan: true },
    });
    return reply.send({
      user: { ...req.user, plan: settings?.plan ?? 'test' },
      settings: settings?.settings ?? {},
    });
  });

  app.patch('/api/me/profile', async (req) => {
    app.requireAuth(req);
    const input = profileSchema.parse(req.body);
    const user = await prisma.user.update({
      where: { id: req.user!.id },
      data: { name: input.name },
      select: { id: true, name: true, email: true },
    });
    return { user };
  });

  app.patch('/api/me/settings', async (req, reply) => {
    app.requireAuth(req);
    const input = userSettingsUpdateSchema.parse(req.body);
    if ('avatar' in input.settings && !avatarOk(input.settings.avatar)) {
      return reply.status(400).send({ error: 'Аватар: изображение JPEG до 150 КБ' });
    }
    const current = await prisma.user.findUnique({
      where: { id: req.user!.id },
      select: { settings: true },
    });
    const prev = current?.settings && typeof current.settings === 'object' && !Array.isArray(current.settings)
      ? current.settings as Record<string, unknown>
      : {};
    const updated = await prisma.user.update({
      where: { id: req.user!.id },
      data: { settings: toJson({ ...prev, ...input.settings }) },
      select: { settings: true },
    });
    return { settings: updated.settings };
  });
};
