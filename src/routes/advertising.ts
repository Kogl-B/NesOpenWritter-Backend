import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { requireAdmin } from '../lib/accountStatus.js';
import { adsenseCredentialsReady, adsenseDay, previousDay, publisherPattern, syncAdSense, validDay } from '../lib/adsense.js';
import { currencySchema, exposureToken, externalAdLink, livePostFilter, placementSchema, readExposureToken } from '../lib/advertising.js';
import { env } from '../lib/env.js';
import { prisma } from '../lib/prisma.js';
import { serviceAccess } from '../lib/serviceSubscriptions.js';
import { tierShowsAds } from '../lib/tiers.js';
import { dayKey } from '../lib/traffic.js';

const settingsId = 'adsense';
const unit = z.string().regex(/^(?:\d{1,20})?$/);
const settingsSchema = z.object({
  publisherId: z.string().regex(/^(?:pub-\d{16})?$/),
  cookiebotId: z.union([z.literal(''), z.string().uuid()]),
  siteUnit: unit, readerUnit: unit, enabled: z.boolean(), autoSync: z.boolean().default(false),
}).superRefine((value, ctx) => {
  if (value.enabled && (!value.publisherId || !value.cookiebotId || (!value.siteUnit && !value.readerUnit))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['enabled'], message: 'Укажите издателя, CMP и минимум один рекламный блок' });
  }
  if (value.siteUnit && value.siteUnit === value.readerUnit) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['readerUnit'], message: 'Для сравнения мест нужны разные блоки AdSense' });
  }
});

const postSchema = z.object({
  title: z.string().trim().min(1).max(150), summary: z.string().trim().min(1).max(320),
  body: z.string().trim().min(1).max(16000), advertiser: z.string().trim().min(1).max(160),
  href: z.string().trim().max(1000).refine(externalAdLink, 'Нужна ссылка HTTPS'),
  imageUrl: z.string().trim().max(1000).refine(externalAdLink, 'Нужна ссылка HTTPS').default(''),
  registrationId: z.string().trim().max(160).default(''),
  revision: z.string().datetime().optional(),
  placement: placementSchema, state: z.enum(['draft', 'active', 'paused', 'archived']),
  priceMinor: z.number().int().min(0).max(100_000_000), currency: currencySchema, paid: z.boolean(),
  startsAt: z.string().datetime(), endsAt: z.string().datetime(),
}).refine(p => Date.parse(p.startsAt) < Date.parse(p.endsAt), { path: ['endsAt'], message: 'Конец должен быть позже начала' })
  .refine(p => !p.paid || p.priceMinor > 0, { path: ['priceMinor'], message: 'Для оплаченной публикации нужна положительная сумма' });

const eventSchema = z.object({ token: z.string().min(1).max(750), type: z.enum(['impression', 'viewable', 'click']) });
const idSchema = z.string().min(1).max(64);
const days = z.object({
  from: z.string().refine(validDay), to: z.string().refine(validDay),
}).refine(d => d.from <= d.to && Date.parse(d.to) - Date.parse(d.from) < 93 * 86_400_000, 'Выберите период до 93 дней');

const defaults = { publisherId: '', cookiebotId: '', siteUnit: '', readerUnit: '', enabled: false, autoSync: false };
const loadSettings = () => prisma.advertisingSettings.findUnique({ where: { id: settingsId } });

type CountRow = {
  day: string; placement: string; postId: string;
  impressions: number; viewable: number; clicks: number;
};

async function overlaps(
  tx: Pick<typeof prisma, '$queryRaw' | 'sponsoredPost'>,
  input: { state: string; placement: string; paidAt: Date | null; startsAt: Date; endsAt: Date },
  id?: string,
): Promise<boolean> {
  if (input.state !== 'active' || !input.paidAt) return false;
  await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtextextended(${'ad-placement:' + input.placement}, 0))`;
  const existing = await tx.sponsoredPost.findFirst({
    where: { placement: input.placement, state: 'active', paidAt: { not: null },
      startsAt: { lt: input.endsAt }, endsAt: { gt: input.startsAt }, id: id ? { not: id } : undefined },
    select: { id: true },
  });
  return !!existing;
}

const occupied = 'На этом месте уже запланирована оплаченная публикация на часть периода';

export const advertisingRoutes: FastifyPluginAsync = async (app) => {
  let startScheduledImport: (() => void) | undefined;
  app.get('/api/admin/access', async (req, reply) => {
    if (await requireAdmin(app, req, reply)) return { ok: true };
  });

  app.get('/ads.txt', async (_req, reply) => {
    const settings = await loadSettings();
    reply.type('text/plain; charset=utf-8').header('Cache-Control', 'public, max-age=300');
    if (!settings?.publisherId || !publisherPattern.test(settings.publisherId)) return reply.code(404).send('ads.txt is not configured\n');
    return reply.send(`google.com, ${settings.publisherId}, DIRECT, f08c47fec0942fa0\n`);
  });

  app.get<{ Params: { slot: string } }>('/api/advertising/placement/:slot', async (req, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    const slot = placementSchema.parse(req.params.slot);
    if (req.user && !tierShowsAds((await serviceAccess(prisma, req.user.id)).plan)) return { ad: null };
    const [post, settings, house] = await Promise.all([
      prisma.sponsoredPost.findFirst({
        where: { placement: slot, ...livePostFilter() }, orderBy: [{ startsAt: 'desc' }, { id: 'desc' }],
        select: { id: true, title: true, summary: true, advertiser: true, registrationId: true },
      }),
      env.ADSENSE_SERVING === 'true' && !req.user && slot !== 'projects-banner' ? loadSettings() : null,
      prisma.houseAd.findUnique({
        where: { id: slot }, select: { enabled: true, audience: true, id: true, title: true, body: true, href: true },
      }),
    ]);
    const fallback = house?.enabled && house.audience === 'free'
      ? { kind: 'house' as const, id: house.id, title: house.title, body: house.body, href: house.href } : null;
    if (post) return { ad: { kind: 'manual', ...post, token: exposureToken(post.id, slot) } };
    if (settings?.enabled && req.headers['x-ow-public-origin'] === `https://${env.ADSENSE_DOMAIN}`) {
      const adUnit = slot === 'site-banner' ? settings.siteUnit : settings.readerUnit;
      if (adUnit && settings.cookiebotId && publisherPattern.test(settings.publisherId)) {
        return { ad: { kind: 'google', client: 'ca-' + settings.publisherId, unit: adUnit, cmpId: settings.cookiebotId }, fallback };
      }
    }
    return { ad: fallback };
  });

  app.get<{ Params: { id: string } }>('/api/advertising/posts/:id', async (req, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    const id = idSchema.parse(req.params.id);
    const post = await prisma.sponsoredPost.findFirst({
      where: { id, ...livePostFilter() },
      select: { id: true, title: true, body: true, advertiser: true, registrationId: true, imageUrl: true, href: true },
    });
    if (!post) return reply.code(404).send({ error: 'Рекламная публикация недоступна' });
    return { post: { ...post, token: exposureToken(post.id, 'post') } };
  });

  app.post('/api/advertising/event', { config: { rateLimit: { max: 180 } } }, async (req, reply) => {
    const input = eventSchema.parse(req.body);
    const exposure = readExposureToken(input.token);
    if (!exposure) return reply.code(400).send({ error: 'Недействительный или просроченный показ' });
    const viewable = input.type === 'viewable';
    const clicked = input.type === 'click';
    const date = dayKey();
    try {
      await prisma.$executeRaw`
        INSERT INTO ad_exposures (id, day, placement, "postId", viewable, clicked)
        VALUES (${exposure.id}, ${date}, ${exposure.placement}, ${exposure.postId}, ${viewable}, ${clicked})
        ON CONFLICT (id) DO UPDATE
        SET viewable = ad_exposures.viewable OR EXCLUDED.viewable,
            clicked = ad_exposures.clicked OR EXCLUDED.clicked
        WHERE (EXCLUDED.viewable AND NOT ad_exposures.viewable) OR (EXCLUDED.clicked AND NOT ad_exposures.clicked)
      `;
    } catch (error) {
      req.log.error({ code: 'AD_EXPOSURE_WRITE_FAILED', severity: 'critical', campaignId: exposure.postId, requestId: req.id, err: error });
      throw error;
    }
    return reply.code(204).send();
  });

  app.get('/api/admin/advertising', async (req, reply) => {
    if (!await requireAdmin(app, req, reply)) return;
    const [settings, posts, houseAds] = await Promise.all([
      loadSettings(),
      prisma.sponsoredPost.findMany({ orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }] }),
      prisma.houseAd.findMany({ orderBy: { sort: 'asc' } }),
    ]);
    return { settings: settings ?? defaults, posts, houseAds,
      readiness: { serving: env.ADSENSE_SERVING === 'true', credentials: adsenseCredentialsReady(), autoSync: !!settings?.autoSync && adsenseCredentialsReady(), domain: env.ADSENSE_DOMAIN } };
  });

  app.put('/api/admin/advertising/settings', async (req, reply) => {
    if (!await requireAdmin(app, req, reply)) return;
    const settings = settingsSchema.parse(req.body);
    if (settings.enabled && env.ADSENSE_SERVING !== 'true') {
      return reply.code(409).send({ error: 'Серверный показ AdSense ещё выключен' });
    }
    if (settings.autoSync && (!settings.publisherId || !adsenseCredentialsReady())) {
      return reply.code(409).send({ error: 'Для автоимпорта укажите издателя и подключите OAuth в Railway' });
    }
    const saved = await prisma.advertisingSettings.upsert({
      where: { id: settingsId }, create: { id: settingsId, ...settings }, update: settings,
    });
    if (saved.autoSync) startScheduledImport?.();
    return { settings: saved };
  });

  app.post('/api/admin/advertising/posts', async (req, reply) => {
    if (!await requireAdmin(app, req, reply)) return;
    const { paid, startsAt, endsAt, revision: _revision, ...input } = postSchema.parse(req.body);
    const data = { ...input, startsAt: new Date(startsAt), endsAt: new Date(endsAt), paidAt: paid ? new Date() : null };
    const post = await prisma.$transaction(async tx => {
      if (await overlaps(tx, data)) return null;
      return tx.sponsoredPost.create({ data });
    });
    if (!post) return reply.code(409).send({ error: occupied });
    return reply.code(201).send({ post });
  });

  app.put<{ Params: { id: string } }>('/api/admin/advertising/posts/:id', async (req, reply) => {
    if (!await requireAdmin(app, req, reply)) return;
    const id = idSchema.parse(req.params.id);
    const { paid, startsAt, endsAt, revision, ...input } = postSchema.parse(req.body);
    const post = await prisma.sponsoredPost.findUnique({ where: { id } });
    if (!post) return reply.code(404).send({ error: 'Публикация не найдена' });
    if (revision !== post.updatedAt.toISOString()) return reply.code(409).send({ error: 'Публикация изменилась. Обновите страницу' });
    if (post.paidAt && paid && (input.priceMinor !== post.priceMinor || input.currency !== post.currency)) {
      return reply.code(409).send({ error: 'Выставленная сумма закреплена за отметкой оплаты' });
    }
    const data = { ...input, startsAt: new Date(startsAt), endsAt: new Date(endsAt), paidAt: paid ? post.paidAt ?? new Date() : null };
    const changed = await prisma.$transaction(async tx => {
      if (await overlaps(tx, data, id)) return null;
      return tx.sponsoredPost.updateMany({ where: { id, updatedAt: post.updatedAt }, data });
    });
    if (!changed) return reply.code(409).send({ error: occupied });
    if (!changed.count) return reply.code(409).send({ error: 'Публикация изменилась. Обновите страницу' });
    return { ok: true };
  });

  app.get('/api/admin/advertising/report', async (req, reply) => {
    if (!await requireAdmin(app, req, reply)) return;
    const { from, to } = days.parse(req.query);
    const settings = await loadSettings();
    const [manual, house, google, sync] = await Promise.all([
      prisma.$queryRaw<CountRow[]>`
        SELECT day, placement, "postId", count(*)::int AS impressions,
               count(*) FILTER (WHERE viewable)::int AS viewable, count(*) FILTER (WHERE clicked)::int AS clicks
        FROM ad_exposures WHERE day BETWEEN ${from} AND ${to}
        GROUP BY day, placement, "postId" ORDER BY day DESC, placement, "postId"
      `,
      prisma.dailyMetric.findMany({
        where: { day: { gte: from, lte: to }, kind: { in: ['ad_show', 'ad_click'] } }, orderBy: { day: 'desc' },
      }),
      settings?.publisherId ? prisma.adSenseDay.findMany({
        where: { publisherId: settings.publisherId, day: { gte: from, lte: to } },
        orderBy: [{ day: 'desc' }, { unit: 'asc' }],
      }) : [],
      settings?.publisherId ? prisma.adSenseSync.findUnique({ where: { publisherId: settings.publisherId } }) : null,
    ]);
    return { manual, house, google: google.map(({ publisherId: _p, ...row }) => ({
      ...row, requests: String(row.requests), matched: String(row.matched), impressions: String(row.impressions),
      clicks: String(row.clicks), earnings: String(row.earnings),
      measurability: row.measurability?.toString() ?? null, viewability: row.viewability?.toString() ?? null,
    })), sync };
  });

  app.post('/api/admin/advertising/adsense/sync', async (req, reply) => {
    if (!await requireAdmin(app, req, reply)) return;
    const { from, to } = days.parse(req.body);
    const settings = await loadSettings();
    if (!settings?.publisherId) return reply.code(409).send({ error: 'Укажите издателя AdSense' });
    if (to > adsenseDay()) return reply.code(400).send({ error: 'Отчёт Google недоступен за будущие даты' });
    try {
      const result = await syncAdSense(settings.publisherId, from, to);
      if (result.status !== 'ok') return reply.code(409).send({ error: result.status === 'busy'
        ? 'Синхронизация уже выполняется' : 'Требуются серверные учётные данные AdSense' });
      return result;
    } catch (error) {
      req.log.error({ code: 'ADSENSE_IMPORT_FAILED', requestId: req.id, from, to,
        reason: error instanceof Error ? error.message.slice(0, 240) : 'unknown' });
      return reply.code(502).send({ error: 'Google не вернул полный отчёт. Сохранённые данные доступны' });
    }
  });

  if (adsenseCredentialsReady()) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    let running = false;
    const schedule = (delay: number) => {
      if (stopped) return;
      clearTimeout(timer);
      timer = setTimeout(() => void importReports(), delay).unref();
    };
    const importReports = async () => {
      if (running || stopped) return;
      running = true;
      try {
        const settings = await loadSettings();
        if (settings?.publisherId && settings.autoSync) {
          const to = adsenseDay();
          const from = previousDay(to, 6);
          const current = await prisma.adSenseSync.findUnique({ where: { publisherId: settings.publisherId } });
          if (!current || current.from > from || current.to < to || Date.now() - current.syncedAt.getTime() >= 5 * 3600_000) {
            await syncAdSense(settings.publisherId, from, to);
          }
        }
      } catch (error) {
        app.log.error({ code: 'ADSENSE_AUTO_IMPORT_FAILED', reason: error instanceof Error ? error.message.slice(0, 240) : 'unknown' });
      } finally {
        running = false;
        schedule(6 * 3600_000);
      }
    };
    startScheduledImport = () => { if (!running) schedule(1000); };
    app.addHook('onReady', async () => { schedule(60_000); });
    app.addHook('onClose', async () => { stopped = true; clearTimeout(timer); });
  }
};
