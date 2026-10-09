import type { FastifyPluginAsync } from 'fastify';

import { prisma } from '../lib/prisma.js';
import { toJson } from '../lib/access.js';
import { userSettingsUpdateSchema } from '../lib/schemas.js';

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

  app.patch('/api/me/settings', async (req) => {
    app.requireAuth(req);
    const input = userSettingsUpdateSchema.parse(req.body);
    const updated = await prisma.user.update({
      where: { id: req.user!.id },
      data: { settings: toJson(input.settings) },
      select: { settings: true },
    });
    return { settings: updated.settings };
  });
};
