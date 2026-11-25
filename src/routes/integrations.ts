import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import { prisma } from '../lib/prisma.js';
import { assertProjectOwnership } from '../lib/access.js';
import { isGdriveConfigured, getAuthUrl, exchangeCodeAndSave, getValidAccessToken, uploadBackup, listBackups, downloadFile } from '../lib/gdrive.js';
import { exportProjectFull, restoreProjectFull, type ProjectBackup } from '../lib/projectTransfer.js';
import { getUserPlan, getUsageInfo } from './account.js';
import { getTier } from '../lib/tiers.js';
import { browserOrigins, env } from '../lib/env.js';
import { driveOAuthAgeSeconds, driveReturnOrigin, newDriveOAuth, readDriveOAuth } from '../lib/driveOAuth.js';

const driveCallbackPath = '/api/integrations/gdrive/callback';
const driveCookie = 'nesow.drive_oauth';
const driveCookieOptions = {
  path: driveCallbackPath,
  httpOnly: true,
  secure: env.NODE_ENV === 'production',
  sameSite: 'lax' as const,
};

const restoreSchema = z.object({ fileId: z.string().min(1).max(256).regex(/^[A-Za-z0-9_-]+$/) });

function backupFileName(projectName: string): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}${pad(now.getMinutes())}`;
  return `OpenWritter — ${projectName} — ${stamp}.json`;
}

export const integrationRoutes: FastifyPluginAsync = async (app) => {
  // --- OAuth -------------------------------------------------------------
  const allowedOrigins = new Set(browserOrigins().filter(
    (origin) => env.NODE_ENV !== 'production' || origin.startsWith('https://'),
  ));
  const providerOrigin = new URL(env.BETTER_AUTH_URL).origin;

  app.get('/api/integrations/gdrive/start', async (req, reply) => {
    app.requireAuth(req);
    if (!isGdriveConfigured()) {
      return reply.status(503).send({
        error: 'Google-интеграция не настроена администратором (GOOGLE_CLIENT_ID/SECRET)',
      });
    }
    const publicOrigin = req.headers['x-ow-public-origin'];
    const origin = typeof publicOrigin === 'string' && allowedOrigins.has(publicOrigin)
      ? publicOrigin : new URL(env.FRONTEND_URL).origin;
    const flow = newDriveOAuth(req.session!.id, origin);
    reply.setCookie(driveCookie, JSON.stringify(flow), {
      ...driveCookieOptions, signed: true, maxAge: driveOAuthAgeSeconds,
    });
    return reply.redirect(getAuthUrl(flow.state, flow.verifier, providerOrigin));
  });

  app.get(driveCallbackPath, async (req, reply) => {
    const url = new URL(req.url, env.BETTER_AUTH_URL);
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const signed = req.cookies[driveCookie];
    // Google's registered callback is on the API host. Route its response
    // to the same frontend origin that holds the initiating session and cookie.
    const returnOrigin = driveReturnOrigin(state);
    if (returnOrigin && allowedOrigins.has(returnOrigin) && !signed && !url.searchParams.has('relay')) {
      const finish = new URL(driveCallbackPath, returnOrigin);
      finish.searchParams.set('state', state!);
      if (code) finish.searchParams.set('code', code);
      if (url.searchParams.has('error')) finish.searchParams.set('error', 'google');
      finish.searchParams.set('relay', '1');
      return reply.redirect(finish.href);
    }
    const cookie = signed ? req.unsignCookie(signed) : null;
    const flow = readDriveOAuth(cookie?.valid ? cookie.value : null, state, req.session?.id);
    const origin = flow && allowedOrigins.has(flow.origin) ? flow.origin : new URL(env.FRONTEND_URL).origin;
    const back = (ok: boolean) => reply.redirect(`${origin}/account?gdrive=${ok ? 'ok' : 'error'}`);
    if (signed) reply.clearCookie(driveCookie, driveCookieOptions);
    if (!flow || !allowedOrigins.has(flow.origin) || !req.user || !code || url.searchParams.has('error')) {
      if (signed && !flow) req.log.warn({ code: 'DRIVE_STATE_REJECTED' }, 'Google Drive callback rejected');
      return back(false);
    }
    try {
      await exchangeCodeAndSave(code, req.user.id, providerOrigin, flow.verifier);
      return back(true);
    } catch {
      req.log.warn({ code: 'DRIVE_EXCHANGE_FAILED' }, 'Google Drive callback failed');
      return back(false);
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
