import { requestNetwork } from '../lib/requestNetwork.js';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { getUserPlan } from './account.js';
import { tierShowsAds } from '../lib/tiers.js';
import {
  bumpMetric,
  isVisitArea,
  recordOnce,
  recordVisit,
} from '../lib/traffic.js';

const browserIdSchema = z.string().uuid().transform((id) => id.toLowerCase()).optional();

const visitSchema = z.object({
  area: z.string(),
  browserId: browserIdSchema,
});

const readSchema = z.object({
  projectId: z.string().min(1).max(64),
  chapterId: z.string().min(1).max(64),
  percent: z.number().int().min(1).max(100),
});

const adEventSchema = z.object({
  type: z.enum(['show', 'click']),
  browserId: browserIdSchema,
});

function markerOf(req: FastifyRequest, browserId?: string): string {
  if (browserId) return `browser:${browserId}`;
  return req.user ? `account:${req.user.id}` : `network:${requestNetwork(req).address ?? 'unknown'}`;
}

async function audienceShowsAds(userId?: string): Promise<boolean> {
  if (!userId) return true;
  return tierShowsAds(await getUserPlan(userId));
}

export const metricsRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onError', async (req, _reply, error) => {
    if (error instanceof z.ZodError || (error.statusCode && error.statusCode < 500)) return;
    req.log.error({
      code: 'SITE_METRICS_REQUEST_FAILED', severity: 'critical', requestId: req.id,
      source: req.routeOptions.url, err: error,
    }, 'Site statistics request failed');
  });

  app.post('/api/metrics/visit', { config: { rateLimit: { max: 180 } } }, async (req, reply) => {
    const input = visitSchema.parse(req.body ?? {});
    if (!isVisitArea(input.area)) return reply.status(400).send({ error: 'Неизвестный раздел' });
    await recordVisit(input.area, markerOf(req, input.browserId), input.browserId);
    return reply.status(204).send();
  });

  app.post('/api/metrics/read', async (req, reply) => {
    app.requireAuth(req);
    const input = readSchema.parse(req.body ?? {});
    const [result] = await prisma.$queryRaw<Array<{ found: boolean }>>`
      WITH target AS (
        SELECT id, "projectId", "charCount"
        FROM chapters WHERE id = ${input.chapterId} AND "projectId" = ${input.projectId}
      ), updated AS (
        INSERT INTO read_progress ("userId", "projectId", "chapterId", percent, "charsSeen", "updatedAt")
        SELECT ${req.user!.id}, "projectId", id, ${input.percent}::int,
               ROUND("charCount"::numeric * ${input.percent}::int / 100)::int, now()
        FROM target
        ON CONFLICT ("userId", "chapterId") DO UPDATE
        SET percent = EXCLUDED.percent,
            "charsSeen" = GREATEST(read_progress."charsSeen", EXCLUDED."charsSeen"),
            "projectId" = EXCLUDED."projectId",
            "updatedAt" = now()
        WHERE read_progress.percent < EXCLUDED.percent
           OR (read_progress.percent = EXCLUDED.percent AND read_progress."charsSeen" < EXCLUDED."charsSeen")
      )
      SELECT EXISTS(SELECT 1 FROM target) AS found
    `;
    if (!result?.found) return reply.status(404).send({ error: 'Глава не найдена' });
    return { ok: true };
  });

  app.get<{ Params: { slot: string } }>('/api/ads/:slot', async (req, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    if (!(await audienceShowsAds(req.user?.id))) return { ad: null };
    const ad = await prisma.houseAd.findUnique({ where: { id: req.params.slot } });
    if (!ad || !ad.enabled || ad.audience !== 'free') return { ad: null };
    return {
      ad: { id: ad.id, title: ad.title, body: ad.body, href: ad.href },
    };
  });

  app.post<{ Params: { slot: string } }>('/api/ads/:slot/event', { config: { rateLimit: { max: 180 } } }, async (req, reply) => {
    const input = adEventSchema.parse(req.body ?? {});
    if (!(await audienceShowsAds(req.user?.id))) return reply.status(204).send();
    const ad = await prisma.houseAd.findUnique({
      where: { id: req.params.slot },
      select: { id: true, enabled: true, audience: true },
    });
    if (!ad?.enabled || ad.audience !== 'free') return reply.status(204).send();
    const marker = markerOf(req, input.browserId);
    const windowMs = input.type === 'show' ? 10 * 60 * 1000 : 2000;
    await recordOnce(`ad:${input.type}:${marker}:${ad.id}`, windowMs, () =>
      bumpMetric(input.type === 'show' ? 'ad_show' : 'ad_click', ad.id),
    );
    return reply.status(204).send();
  });
};
