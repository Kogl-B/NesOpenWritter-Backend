import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { getUserPlan } from './account.js';
import { tierShowsAds } from '../lib/tiers.js';
import {
  bumpMetric,
  claimDailyUnique,
  isVisitArea,
  recentlySeen,
} from '../lib/traffic.js';

const visitSchema = z.object({
  area: z.string(),
  firstToday: z.boolean().optional(),
});

const readSchema = z.object({
  projectId: z.string().min(1).max(64),
  chapterId: z.string().min(1).max(64),
  percent: z.number().int().min(1).max(100),
});

const adEventSchema = z.object({
  type: z.enum(['show', 'click']),
});

function markerOf(req: { ip: string; user?: { id: string } | null }): string {
  return req.user?.id ?? req.ip;
}

async function audienceShowsAds(userId?: string): Promise<boolean> {
  if (!userId) return true;
  return tierShowsAds(await getUserPlan(userId));
}

export const metricsRoutes: FastifyPluginAsync = async (app) => {
  app.post('/api/metrics/visit', async (req, reply) => {
    const input = visitSchema.parse(req.body ?? {});
    if (!isVisitArea(input.area)) return reply.status(400).send({ error: 'Неизвестный раздел' });
    const marker = markerOf(req);
    if (!recentlySeen(`view:${marker}:${input.area}`, 1500)) {
      await bumpMetric('view', input.area);
    }
    if (input.firstToday && claimDailyUnique(marker, new Date().toISOString().slice(0, 10))) {
      await bumpMetric('unique', 'site');
    }
    return reply.status(204).send();
  });

  app.post('/api/metrics/read', async (req, reply) => {
    app.requireAuth(req);
    const input = readSchema.parse(req.body ?? {});
    if (recentlySeen(`read:${req.user!.id}:${input.chapterId}`, 5000)) {
      return { ok: true, skipped: true };
    }
    const chapter = await prisma.chapter.findFirst({
      where: { id: input.chapterId, projectId: input.projectId },
      select: { charCount: true },
    });
    if (!chapter) return reply.status(404).send({ error: 'Глава не найдена' });
    const charsSeen = Math.round((chapter.charCount * input.percent) / 100);
    await prisma.$executeRaw`
      INSERT INTO read_progress ("userId", "projectId", "chapterId", percent, "charsSeen", "updatedAt")
      VALUES (${req.user!.id}, ${input.projectId}, ${input.chapterId}, ${input.percent}, ${charsSeen}, now())
      ON CONFLICT ("userId", "chapterId") DO UPDATE
      SET percent = GREATEST(read_progress.percent, EXCLUDED.percent),
          "charsSeen" = CASE
            WHEN EXCLUDED.percent >= read_progress.percent THEN EXCLUDED."charsSeen"
            ELSE read_progress."charsSeen"
          END,
          "projectId" = EXCLUDED."projectId",
          "updatedAt" = now()
      WHERE read_progress.percent < EXCLUDED.percent
         OR read_progress."charsSeen" < EXCLUDED."charsSeen"
    `;
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

  app.post<{ Params: { slot: string } }>('/api/ads/:slot/event', async (req, reply) => {
    const input = adEventSchema.parse(req.body ?? {});
    if (!(await audienceShowsAds(req.user?.id))) return reply.status(204).send();
    const ad = await prisma.houseAd.findUnique({
      where: { id: req.params.slot },
      select: { id: true, enabled: true, audience: true },
    });
    if (!ad?.enabled || ad.audience !== 'free') return reply.status(204).send();
    const marker = markerOf(req);
    const windowMs = input.type === 'show' ? 10 * 60 * 1000 : 2000;
    if (!recentlySeen(`ad:${input.type}:${marker}:${ad.id}`, windowMs)) {
      await bumpMetric(input.type === 'show' ? 'ad_show' : 'ad_click', ad.id);
    }
    return reply.status(204).send();
  });
};
