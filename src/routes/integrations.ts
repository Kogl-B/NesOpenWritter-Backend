import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import { prisma } from '../lib/prisma.js';
import { assertProjectOwnership } from '../lib/access.js';
import { isGdriveConfigured, getAuthUrl, verifyCallbackState, exchangeCodeAndSave, getValidAccessToken, uploadBackup, listBackups, downloadFile } from '../lib/gdrive.js';
import { exportProjectFull, restoreProjectFull, type ProjectBackup } from '../lib/projectTransfer.js';
import { getUserPlan, getUsageInfo } from './account.js';
import { getTier } from '../lib/tiers.js';
import { env } from '../lib/env.js';

/** Origin текущего запроса с учётом прокси Railway. */
function reqOrigin(req: { headers: Record<string, unknown>; protocol: string }): string {
  const proto = (req.headers['x-forwarded-proto'] as string) ?? req.protocol;
  const host = (req.headers['x-forwarded-host'] as string) ?? (req.headers.host as string);
  return `${proto}://${host}`;
}

const restoreSchema = z.object({ fileId: z.string().min(1) });

function backupFileName(projectName: string): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}${pad(now.getMinutes())}`;
  return `OpenWritter — ${projectName} — ${stamp}.json`;
}

export const integrationRoutes: FastifyPluginAsync = async (app) => {
  // --- OAuth -------------------------------------------------------------
  // Старт и callback НЕ под requireAuth-хуком: туда приходит редирект Google.

  app.get('/api/integrations/gdrive/start', async (req, reply) => {
    app.requireAuth(req);
    if (!isGdriveConfigured()) {
      return reply.status(503).send({
        error: 'Google-интеграция не настроена администратором (GOOGLE_CLIENT_ID/SECRET)',
      });
    }
    return reply.redirect(getAuthUrl(req.user!.id, reqOrigin(req)));
  });

  app.get('/api/integrations/gdrive/callback', async (req, reply) => {
    const url = new URL(req.url, env.BETTER_AUTH_URL);
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const err = url.searchParams.get('error');
    const back = (ok: boolean, reason = '') =>
      reply.redirect(`${env.FRONTEND_URL.replace(/\/$/, '')}/account?gdrive=${ok ? 'ok' : 'error'}${reason ? `&reason=${encodeURIComponent(reason)}` : ''}`);
    if (err || !code) return back(false, err ?? 'no code');
    const userId = verifyCallbackState(state ?? undefined);
    if (!userId) return back(false, 'bad state');
    try {
      await exchangeCodeAndSave(code, userId, reqOrigin(req));
      return back(true);
    } catch (e) {
      return back(false, e instanceof Error ? e.message.slice(0, 120) : 'exchange failed');
    }
  });

  app.get('/api/integrations/gdrive/status', async (req) => {
    app.requireAuth(req);
    const integration = await prisma.userIntegration.findUnique({
      where: { userId_provider: { userId: req.user!.id, provider: 'gdrive' } },
      select: { email: true, createdAt: true },
    });
    return {
      configured: isGdriveConfigured(),
      connected: !!integration,
      email: integration?.email ?? null,
      connectedAt: integration?.createdAt ?? null,
    };
  });

  app.delete('/api/integrations/gdrive', async (req) => {
    app.requireAuth(req);
    await prisma.userIntegration.deleteMany({
      where: { userId: req.user!.id, provider: 'gdrive' },
    });
    return { ok: true };
  });

  // --- Бэкап проекта на Диск ----------------------------------------------

  app.post<{ Params: { projectId: string } }>(
    '/api/projects/:projectId/backup/gdrive',
    async (req, reply) => {
      app.requireAuth(req);
      if (!(await assertProjectOwnership(req.params.projectId, req.user!.id))) {
        return reply.status(404).send({ error: 'Project not found' });
      }
      const backup = await exportProjectFull(req.params.projectId);
      const fileName = backupFileName(backup.project.name);
      const file = await uploadBackup(req.user!.id, fileName, JSON.stringify(backup));
      return { file };
    }
  );

  app.get('/api/integrations/gdrive/files', async (req) => {
    app.requireAuth(req);
    const files = await listBackups(req.user!.id);
    return { files };
  });

  // --- Восстановление проекта с Диска --------------------------------------

  app.post('/api/projects/restore/gdrive', async (req, reply) => {
    app.requireAuth(req);
    const input = restoreSchema.parse(req.body);
    // Лимит проектов тарифа действует и на восстановление
    const tier = getTier(await getUserPlan(req.user!.id));
    if (tier.projectLimit != null) {
      const usage = await getUsageInfo(req.user!.id);
      if (usage.projects.used >= tier.projectLimit) {
        return reply.status(403).send({
          error: `Достигнут лимит тарифа «${tier.name}»: ${tier.projectLimit} проектов. Освободите слот или смените тариф, затем повторите восстановление.`,
        });
      }
    }
    let backup: ProjectBackup;
    try {
      const raw = await downloadFile(req.user!.id, input.fileId);
      backup = JSON.parse(raw) as ProjectBackup;
    } catch (e) {
      return reply.status(400).send({
        error: `Не удалось прочитать файл с Диска: ${e instanceof Error ? e.message.slice(0, 120) : 'unknown'}`,
      });
    }
    const result = await restoreProjectFull(req.user!.id, backup);
    return reply.status(201).send({ projectId: result.projectId, counts: result.counts });
  });

  // Самопроверка подключения (используется фронтом после OAuth-редиректа)
  app.get('/api/integrations/gdrive/ping', async (req, reply) => {
    app.requireAuth(req);
    try {
      await getValidAccessToken(req.user!.id);
      return { ok: true };
    } catch {
      return reply.status(400).send({ error: 'Google Диск не подключён' });
    }
  });
};
