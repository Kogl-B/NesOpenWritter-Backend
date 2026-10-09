import type { FastifyInstance } from 'fastify';
import { prisma } from '../lib/prisma.js';
import { env } from '../lib/env.js';
import { getMetrics, resetMetrics, getDegradationAlerts } from '../lib/metrics.js';
import { getDbMetrics } from '../lib/prisma.js';

/**
 * Админ-контур. Доступ — только для email из ADMIN_EMAILS (запятая-разделённый
 * список). Без переменной эндпоинты возвращают 403 всем: админ-режим выключен.
 */
function isAdmin(email: string | null | undefined): boolean {
  if (!email || !env.ADMIN_EMAILS) return false;
  const list = env.ADMIN_EMAILS.split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return list.includes(email.toLowerCase());
}

export async function adminRoutes(app: FastifyInstance) {
  app.get('/api/admin/stats', async (req, reply) => {
    // NB: requireAuth вызываем вручную (паттерн всех роутов) — декоратор в
    // preHandler-массиве с arity 1 подвешивал запрос без ответа
    app.requireAuth(req);
    if (!isAdmin(req.user?.email)) {
      return reply.status(403).send({ error: 'Admin access required' });
    }
    const [users, projects, activeSessions] = await Promise.all([
      prisma.user.count(),
      prisma.project.count(),
      prisma.session.count({
        where: { expiresAt: { gt: new Date() } },
      }),
    ]);
    return { users, projects, activeSessions };
  });

  // === Performance metrics ===
  app.get('/api/admin/metrics', async (req, reply) => {
    app.requireAuth(req);
    if (!isAdmin(req.user?.email)) {
      return reply.status(403).send({ error: 'Admin access required' });
    }
    return {
      ...getMetrics(),
      db: getDbMetrics(),
      degradationAlerts: getDegradationAlerts(),
    };
  });

  app.post('/api/admin/metrics/reset', async (req, reply) => {
    app.requireAuth(req);
    if (!isAdmin(req.user?.email)) {
      return reply.status(403).send({ error: 'Admin access required' });
    }
    resetMetrics();
    return { status: 'reset' };
  });
}
