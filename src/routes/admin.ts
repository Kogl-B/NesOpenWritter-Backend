import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { prisma } from '../lib/prisma.js';
import { getMetrics, resetMetrics, getDegradationAlerts } from '../lib/metrics.js';
import { getDbMetrics } from '../lib/prisma.js';
import {
  ACCOUNT_STATUSES,
  isAccountStatus,
  requireAdmin,
  STATUS_CATALOG,
} from '../lib/accountStatus.js';
import { MODEL_PRESETS, completeDeepSeek, costUsdMicros, isPeakHour, withMarkup } from '../lib/ai/deepseek.js';
import { ensureImageProvider, ensureProvider, periodStart, recordUsage } from '../lib/ai/meter.js';
import {
  DEFAULT_OPENAI_IMAGE_MODEL,
  IMAGE_QUALITIES,
  IMAGE_SIZE_CHOICES,
  OPENAI_IMAGE_MODEL_TITLES,
  OPENAI_IMAGE_MODELS,
  isOpenAIImageModel,
  normalizeImageModel,
  normalizeImageOptions,
  probeOpenAIImageKey,
  publicGeneration,
  readGeneration,
  splitOpenAIKeys,
} from '../lib/ai/openaiImage.js';
import { openSecret, sealSecret, secretHint } from '../lib/ai/secret.js';
import { loadBookReading, loadReaderStats, loadSiteStats } from '../lib/siteStats.js';
import { safeAdHref } from '../lib/traffic.js';

function dayKey(value: Date): string {
  return value.toISOString().slice(0, 10);
}

const userPatchSchema = z.object({
  accountStatus: z.enum(ACCOUNT_STATUSES),
});

const aiPutSchema = z.object({
  apiKey: z.string().trim().max(4000).optional(),
  clearKey: z.boolean().optional(),
  baseUrl: z.string().trim().url().max(200),
  model: z.string().trim().min(1).max(64),
  enabled: z.boolean(),
  inputMissUsdPerM: z.number().int().min(0).max(100_000_000),
  inputHitUsdPerM: z.number().int().min(0).max(100_000_000),
  outputUsdPerM: z.number().int().min(0).max(100_000_000),
  peakMultiplier: z.number().int().min(1).max(4),
  chargeMultiplier: z.number().int().min(1).max(20).default(3),
  testQuota: z.number().int().min(0).max(100_000_000),
  regularQuota: z.number().int().min(0).max(100_000_000),
  adminQuota: z.number().int().min(0).max(100_000_000),
});

const imagePutSchema = z.object({
  apiKey: z.string().trim().max(4000).optional(),
  clearKey: z.boolean().optional(),
  baseUrl: z.string().trim().url().max(200),
  model: z.enum(OPENAI_IMAGE_MODELS),
  enabled: z.boolean(),
  inputMissUsdPerM: z.number().int().min(0).max(100_000_000).default(5_000_000),
  inputHitUsdPerM: z.number().int().min(0).max(100_000_000).default(8_000_000),
  outputUsdPerM: z.number().int().min(0).max(100_000_000).default(30_000_000),
  chargeMultiplier: z.number().int().min(1).max(20).default(3),
  size: z.string().trim().max(20).default('1024x1024'),
  quality: z.string().trim().max(20).default('low'),
  outputFormat: z.enum(['png', 'jpeg', 'webp']).default('png'),
  outputCompression: z.number().int().min(0).max(100).default(100),
  background: z.enum(['auto', 'opaque', 'transparent']).default('auto'),
  moderation: z.enum(['auto', 'low']).default('auto'),
});

function publicImageProvider(row: Awaited<ReturnType<typeof ensureImageProvider>>) {
  const model = isOpenAIImageModel(row.model) ? row.model : DEFAULT_OPENAI_IMAGE_MODEL;
  const generation = publicGeneration(readGeneration(row.generation, model));
  return {
    provider: row.provider,
    label: row.label,
    baseUrl: row.baseUrl,
    model,
    enabled: row.enabled,
    hasKey: row.keyCipher.length > 0,
    keyHint: row.keyHint,
    inputMissUsdPerM: row.inputMissUsdPerM,
    inputHitUsdPerM: row.inputHitUsdPerM,
    outputUsdPerM: row.outputUsdPerM,
    chargeMultiplier: row.chargeMultiplier,
    generation,
    modes: OPENAI_IMAGE_MODELS.map((id) => ({ id, title: OPENAI_IMAGE_MODEL_TITLES[id] })),
    sizes: IMAGE_SIZE_CHOICES,
    qualities: IMAGE_QUALITIES,
  };
}

function publicProvider(row: Awaited<ReturnType<typeof ensureProvider>>) {
  return {
    provider: row.provider,
    label: row.label,
    baseUrl: row.baseUrl,
    model: row.model,
    enabled: row.enabled,
    hasKey: row.keyCipher.length > 0,
    keyHint: row.keyHint,
    inputMissUsdPerM: row.inputMissUsdPerM,
    inputHitUsdPerM: row.inputHitUsdPerM,
    outputUsdPerM: row.outputUsdPerM,
    peakMultiplier: row.peakMultiplier,
    chargeMultiplier: row.chargeMultiplier,
    testQuota: row.testQuota,
    regularQuota: row.regularQuota,
    adminQuota: row.adminQuota,
    models: Object.entries(MODEL_PRESETS).map(([id, preset]) => ({
      id,
      title: preset.title,
      prices: preset.prices,
    })),
    statuses: STATUS_CATALOG,
  };
}

export async function adminRoutes(app: FastifyInstance) {
  app.get('/api/admin/stats', async (req, reply) => {
    if (!(await requireAdmin(app, req, reply))) return;
    const since30 = periodStart();
    const since1 = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const since14 = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
    const [users, projects, activeSessions, statusRows, usage30, usage1, dayRows, accountRows, projectRows, provider, site] = await Promise.all([
      prisma.user.count(),
      prisma.project.count(),
      prisma.session.count({ where: { expiresAt: { gt: new Date() } } }),
      prisma.user.groupBy({ by: ['accountStatus'], _count: true }),
      prisma.aiUsage.aggregate({
        where: { createdAt: { gte: since30 } },
        _sum: { totalTokens: true, costUsdMicros: true },
        _count: true,
      }),
      prisma.aiUsage.aggregate({
        where: { createdAt: { gte: since1 } },
        _sum: { totalTokens: true, costUsdMicros: true },
        _count: true,
      }),
      prisma.$queryRaw<Array<{ day: Date; tokens: bigint; cost: bigint; requests: bigint }>>`
        SELECT date_trunc('day', "createdAt") AS day,
               COALESCE(SUM("totalTokens"), 0) AS tokens,
               COALESCE(SUM("costUsdMicros"), 0) AS cost,
               COUNT(*)::bigint AS requests
        FROM ai_usages
        WHERE "createdAt" >= ${since14}
        GROUP BY 1
        ORDER BY 1
      `,
      prisma.aiUsage.groupBy({
        by: ['userId'],
        where: { createdAt: { gte: since30 } },
        _sum: { totalTokens: true, costUsdMicros: true },
        _count: true,
        orderBy: { _sum: { totalTokens: 'desc' } },
        take: 8,
      }),
      prisma.aiUsage.groupBy({
        by: ['projectId'],
        where: { createdAt: { gte: since30 }, projectId: { not: null } },
        _sum: { totalTokens: true, costUsdMicros: true },
        _count: true,
        orderBy: { _sum: { totalTokens: 'desc' } },
        take: 8,
      }),
      ensureProvider(),
      loadSiteStats(),
    ]);
    const byStatus = { test: 0, regular: 0, admin: 0 };
    for (const row of statusRows) {
      if (isAccountStatus(row.accountStatus)) byStatus[row.accountStatus] = row._count;
    }
    const accountIds = accountRows.map((row) => row.userId);
    const projectIds = projectRows.map((row) => row.projectId).filter((id): id is string => !!id);
    const [accountUsers, projectNames] = await Promise.all([
      accountIds.length
        ? prisma.user.findMany({
          where: { id: { in: accountIds } },
          select: { id: true, email: true, name: true, accountStatus: true },
        })
        : [],
      projectIds.length
        ? prisma.project.findMany({ where: { id: { in: projectIds } }, select: { id: true, name: true } })
        : [],
    ]);
    const userById = new Map(accountUsers.map((user) => [user.id, user]));
    const projectById = new Map(projectNames.map((project) => [project.id, project.name]));
    return {
      users,
      projects,
      activeSessions,
      byStatus,
      statuses: STATUS_CATALOG,
      ai: {
        configured: provider.keyCipher.length > 0,
        enabled: provider.enabled,
        model: provider.model,
        requests30: usage30._count,
        tokens30: usage30._sum.totalTokens ?? 0,
        costUsdMicros30: usage30._sum.costUsdMicros ?? 0,
        requests1: usage1._count,
        tokens1: usage1._sum.totalTokens ?? 0,
        costUsdMicros1: usage1._sum.costUsdMicros ?? 0,
        days: dayRows.map((row) => ({
          day: dayKey(row.day),
          tokens: Number(row.tokens),
          costUsdMicros: Number(row.cost),
          requests: Number(row.requests),
        })),
        topAccounts: accountRows.map((row) => {
          const user = userById.get(row.userId);
          return {
            userId: row.userId,
            name: user?.name ?? '',
            email: user?.email ?? '',
            status: isAccountStatus(user?.accountStatus) ? user.accountStatus : 'test',
            tokens: row._sum.totalTokens ?? 0,
            costUsdMicros: row._sum.costUsdMicros ?? 0,
            requests: row._count,
          };
        }),
        topProjects: projectRows.map((row) => ({
          projectId: row.projectId,
          name: (row.projectId && projectById.get(row.projectId)) || 'Проект удалён',
          tokens: row._sum.totalTokens ?? 0,
          costUsdMicros: row._sum.costUsdMicros ?? 0,
          requests: row._count,
        })),
      },
      site,
    };
  });

  app.get('/api/admin/users', async (req, reply) => {
    if (!(await requireAdmin(app, req, reply))) return;
    const query = z.object({
      q: z.string().trim().max(80).optional(),
      status: z.enum(ACCOUNT_STATUSES).optional(),
      page: z.coerce.number().int().min(1).default(1),
    }).parse(req.query);
    const where = {
      ...(query.status ? { accountStatus: query.status } : {}),
      ...(query.q
        ? {
          OR: [
            { email: { contains: query.q, mode: 'insensitive' as const } },
            { name: { contains: query.q, mode: 'insensitive' as const } },
          ],
        }
        : {}),
    };
    const pageSize = 25;
    const [total, rows] = await Promise.all([
      prisma.user.count({ where }),
      prisma.user.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * pageSize,
        take: pageSize,
        select: { id: true, email: true, name: true, accountStatus: true, plan: true, createdAt: true },
      }),
    ]);
    const ids = rows.map((row) => row.id);
    const since = periodStart();
    const [tokenRows, projectRows] = await Promise.all([
      ids.length
        ? prisma.aiUsage.groupBy({
          by: ['userId'],
          where: { userId: { in: ids }, createdAt: { gte: since } },
          _sum: { totalTokens: true, costUsdMicros: true },
          _count: true,
        })
        : [],
      ids.length
        ? prisma.project.groupBy({ by: ['ownerId'], where: { ownerId: { in: ids } }, _count: true })
        : [],
    ]);
    const tokens = new Map(tokenRows.map((row) => [row.userId, row]));
    const projects = new Map(projectRows.map((row) => [row.ownerId, row._count]));
    return {
      page: query.page,
      pages: Math.max(1, Math.ceil(total / pageSize)),
      total,
      users: rows.map((row) => {
        const spent = tokens.get(row.id);
        return {
          id: row.id,
          email: row.email,
          name: row.name ?? '',
          accountStatus: isAccountStatus(row.accountStatus) ? row.accountStatus : 'test',
          plan: row.plan ?? 'test',
          createdAt: row.createdAt,
          projects: projects.get(row.id) ?? 0,
          tokens30: spent?._sum.totalTokens ?? 0,
          costUsdMicros30: spent?._sum.costUsdMicros ?? 0,
          requests30: spent?._count ?? 0,
        };
      }),
    };
  });

  app.get<{ Params: { userId: string } }>('/api/admin/users/:userId', async (req, reply) => {
    if (!(await requireAdmin(app, req, reply))) return;
    const user = await prisma.user.findUnique({
      where: { id: req.params.userId },
      select: { id: true, email: true, name: true, accountStatus: true, plan: true, createdAt: true },
    });
    if (!user) return reply.status(404).send({ error: 'Аккаунт не найден' });
    const since = periodStart();
    const [projects, logins, spent, recent, provider] = await Promise.all([
      prisma.project.count({ where: { ownerId: user.id } }),
      prisma.account.findMany({
        where: { userId: user.id },
        select: { providerId: true, createdAt: true },
        orderBy: { createdAt: 'asc' },
      }),
      prisma.aiUsage.aggregate({
        where: { userId: user.id, createdAt: { gte: since } },
        _sum: { totalTokens: true, costUsdMicros: true },
        _count: true,
      }),
      prisma.aiUsage.findMany({
        where: { userId: user.id },
        orderBy: { createdAt: 'desc' },
        take: 12,
        select: {
          id: true,
          createdAt: true,
          purpose: true,
          model: true,
          totalTokens: true,
          costUsdMicros: true,
          projectId: true,
          peak: true,
        },
      }),
      ensureProvider(),
    ]);
    const projectIds = recent.map((row) => row.projectId).filter((id): id is string => !!id);
    const names = projectIds.length
      ? await prisma.project.findMany({ where: { id: { in: projectIds } }, select: { id: true, name: true } })
      : [];
    const nameOf = new Map(names.map((project) => [project.id, project.name]));
    const status = isAccountStatus(user.accountStatus) ? user.accountStatus : 'test';
    return {
      user: {
        ...user,
        name: user.name ?? '',
        accountStatus: status,
        plan: user.plan ?? 'test',
        projects,
        logins,
      },
      rights: STATUS_CATALOG[status].rights,
      quota: {
        used: spent._sum.totalTokens ?? 0,
        limit: status === 'admin'
          ? (provider.adminQuota > 0 ? provider.adminQuota : null)
          : status === 'regular'
            ? (provider.regularQuota > 0 ? provider.regularQuota : null)
            : (provider.testQuota > 0 ? provider.testQuota : null),
        costUsdMicros: spent._sum.costUsdMicros ?? 0,
        requests: spent._count,
        periodDays: 30,
      },
      recent: recent.map((row) => ({
        ...row,
        projectName: row.projectId ? (nameOf.get(row.projectId) ?? 'Проект удалён') : '',
      })),
    };
  });

  app.patch<{ Params: { userId: string } }>('/api/admin/users/:userId', async (req, reply) => {
    if (!(await requireAdmin(app, req, reply))) return;
    const input = userPatchSchema.parse(req.body);
    const current = await prisma.user.findUnique({
      where: { id: req.params.userId },
      select: { id: true, accountStatus: true },
    });
    if (!current) return reply.status(404).send({ error: 'Аккаунт не найден' });
    if (current.accountStatus === 'admin' && input.accountStatus !== 'admin') {
      const admins = await prisma.user.count({ where: { accountStatus: 'admin' } });
      if (admins <= 1) {
        return reply.status(409).send({ error: 'Это последний админский аккаунт. Сначала назначьте другого.' });
      }
    }
    const updated = await prisma.user.update({
      where: { id: current.id },
      data: { accountStatus: input.accountStatus },
      select: { id: true, accountStatus: true },
    });
    return { user: updated };
  });

  app.get('/api/admin/ai', async (req, reply) => {
    if (!(await requireAdmin(app, req, reply))) return;
    return publicProvider(await ensureProvider());
  });

  app.put('/api/admin/ai', async (req, reply) => {
    if (!(await requireAdmin(app, req, reply))) return;
    const input = aiPutSchema.parse(req.body);
    let parsed: URL;
    try {
      parsed = new URL(input.baseUrl);
    } catch {
      return reply.status(400).send({ error: 'Некорректный адрес API' });
    }
    if (parsed.protocol !== 'https:') {
      return reply.status(400).send({ error: 'Адрес API должен начинаться с https://' });
    }
    const current = await ensureProvider();
    let keyCipher = current.keyCipher;
    let keyHint = current.keyHint;
    if (input.clearKey) {
      keyCipher = '';
      keyHint = '';
    } else if (input.apiKey) {
      keyCipher = sealSecret(input.apiKey);
      keyHint = secretHint(input.apiKey);
    }
    if (input.enabled && !keyCipher) {
      return reply.status(400).send({ error: 'Сначала сохраните ключ, потом включайте ИИ' });
    }
    const saved = await prisma.aiProvider.update({
      where: { provider: 'deepseek' },
      data: {
        baseUrl: parsed.origin,
        model: input.model,
        enabled: input.enabled,
        inputMissUsdPerM: input.inputMissUsdPerM,
        inputHitUsdPerM: input.inputHitUsdPerM,
        outputUsdPerM: input.outputUsdPerM,
        peakMultiplier: input.peakMultiplier,
        chargeMultiplier: input.chargeMultiplier,
        testQuota: input.testQuota,
        regularQuota: input.regularQuota,
        adminQuota: input.adminQuota,
        keyCipher,
        keyHint,
      },
    });
    return publicProvider(saved);
  });

  app.post('/api/admin/ai/test', async (req, reply) => {
    if (!(await requireAdmin(app, req, reply))) return;
    const provider = await ensureProvider();
    if (!provider.keyCipher) return reply.status(400).send({ error: 'Ключ ещё не сохранён' });
    let apiKey: string;
    try {
      apiKey = openSecret(provider.keyCipher);
    } catch {
      return reply.status(500).send({ error: 'Ключ ИИ не читается. Сохраните его заново.' });
    }
    try {
      const result = await completeDeepSeek({
        baseUrl: provider.baseUrl,
        apiKey,
        model: provider.model,
        messages: [
          { role: 'system', content: 'Ответь одним словом.' },
          { role: 'user', content: 'Напиши: да' },
        ],
        maxTokens: 32,
        temperature: 0,
      });
      const real = costUsdMicros(result.usage, provider, isPeakHour(), provider.peakMultiplier);
      const row = await recordUsage({
        userId: req.user!.id,
        projectId: null,
        model: provider.model,
        purpose: 'test',
        usage: result.usage,
        prices: provider,
        peakMultiplier: provider.peakMultiplier,
        costUsdMicros: withMarkup(real, provider.chargeMultiplier),
      });
      return {
        text: result.text,
        usage: { totalTokens: row.totalTokens, costUsdMicros: row.costUsdMicros, peak: row.peak },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'DeepSeek не ответил';
      return reply.status(502).send({ error: message });
    }
  });

  app.get('/api/admin/ai/image', async (req, reply) => {
    if (!(await requireAdmin(app, req, reply))) return;
    return publicImageProvider(await ensureImageProvider());
  });

  app.put('/api/admin/ai/image', async (req, reply) => {
    if (!(await requireAdmin(app, req, reply))) return;
    const input = imagePutSchema.parse(req.body);
    let parsed: URL;
    try {
      parsed = new URL(input.baseUrl);
    } catch {
      return reply.status(400).send({ error: 'Некорректный адрес API' });
    }
    if (parsed.protocol !== 'https:') {
      return reply.status(400).send({ error: 'Адрес API должен начинаться с https://' });
    }
    const current = await ensureImageProvider();
    let keyCipher = current.keyCipher;
    let keyHint = current.keyHint;
    if (input.clearKey) {
      keyCipher = '';
      keyHint = '';
    } else if (input.apiKey) {
      const keys = splitOpenAIKeys(input.apiKey);
      if (keys.length === 0) return reply.status(400).send({ error: 'Ключ пустой' });
      keyCipher = sealSecret(keys.join('\n'));
      keyHint = secretHint(keys[keys.length - 1] ?? '');
    }
    if (input.enabled && !keyCipher) {
      return reply.status(400).send({ error: 'Сначала сохраните ключ, потом включайте генерацию' });
    }
    let generation: ReturnType<typeof normalizeImageOptions>;
    try {
      generation = normalizeImageOptions({
        model: input.model,
        size: input.size,
        quality: input.quality,
        output_format: input.outputFormat,
        output_compression: input.outputCompression,
        background: input.background,
        moderation: input.moderation,
      });
    } catch (err) {
      return reply.status(400).send({ error: err instanceof Error ? err.message : 'Настройки генерации не подходят' });
    }
    const saved = await prisma.aiProvider.update({
      where: { provider: 'openai-image' },
      data: {
        baseUrl: parsed.origin,
        model: input.model,
        enabled: input.enabled,
        inputMissUsdPerM: input.inputMissUsdPerM,
        inputHitUsdPerM: input.inputHitUsdPerM,
        outputUsdPerM: input.outputUsdPerM,
        chargeMultiplier: input.chargeMultiplier,
        generation,
        keyCipher,
        keyHint,
      },
    });
    return publicImageProvider(saved);
  });

  app.post('/api/admin/ai/image/test', async (req, reply) => {
    if (!(await requireAdmin(app, req, reply))) return;
    const provider = await ensureImageProvider();
    if (!provider.keyCipher) return reply.status(400).send({ error: 'Ключ ещё не сохранён' });
    let keys: string[];
    try {
      keys = splitOpenAIKeys(openSecret(provider.keyCipher));
    } catch {
      return reply.status(500).send({ error: 'Ключ OpenAI не читается. Сохраните его заново.' });
    }
    if (keys.length === 0) return reply.status(400).send({ error: 'Ключ ещё не сохранён' });
    const model = normalizeImageModel(provider.model);
    const checks = [];
    for (const key of keys) {
      checks.push(await probeOpenAIImageKey({ apiKey: key, model, baseUrl: provider.baseUrl }));
    }
    const valid = checks.filter((row) => row.ok).length;
    return {
      ok: valid > 0,
      model,
      validKeys: valid,
      totalKeys: checks.length,
      error: valid > 0 ? undefined : checks[0] && !checks[0].ok ? checks[0].error : 'Ключ не открыл модель',
    };
  });

  app.get('/api/admin/metrics', async (req, reply) => {
    if (!(await requireAdmin(app, req, reply))) return;
    return {
      ...getMetrics(),
      db: getDbMetrics(),
      degradationAlerts: getDegradationAlerts(),
    };
  });

  app.post('/api/admin/metrics/reset', async (req, reply) => {
    if (!(await requireAdmin(app, req, reply))) return;
    resetMetrics();
    return { status: 'reset' };
  });

  app.get<{ Params: { projectId: string } }>('/api/admin/stats/books/:projectId', async (req, reply) => {
    if (!(await requireAdmin(app, req, reply))) return;
    const book = await loadBookReading(req.params.projectId);
    if (!book) return reply.status(404).send({ error: 'Книга не найдена' });
    return book;
  });

  app.get('/api/admin/stats/readers', async (req, reply) => {
    if (!(await requireAdmin(app, req, reply))) return;
    const query = z.object({ email: z.string().trim().email().max(200) }).parse(req.query);
    const reader = await loadReaderStats(query.email);
    if (!reader) return reply.status(404).send({ error: 'Аккаунт не найден' });
    return reader;
  });

  const adPatchSchema = z.object({
    title: z.string().trim().min(1).max(80),
    body: z.string().trim().min(1).max(280),
    href: z.string().trim().min(1).max(300),
    enabled: z.boolean(),
  });

  app.patch<{ Params: { id: string } }>('/api/admin/ads/:id', async (req, reply) => {
    if (!(await requireAdmin(app, req, reply))) return;
    const input = adPatchSchema.parse(req.body);
    if (!safeAdHref(input.href)) {
      return reply.status(400).send({ error: 'Ссылка может быть путём сайта или адресом https' });
    }
    const existing = await prisma.houseAd.findUnique({ where: { id: req.params.id }, select: { id: true } });
    if (!existing) return reply.status(404).send({ error: 'Блок не найден' });
    const ad = await prisma.houseAd.update({
      where: { id: req.params.id },
      data: input,
    });
    return {
      id: ad.id,
      title: ad.title,
      body: ad.body,
      href: ad.href,
      enabled: ad.enabled,
    };
  });
};
