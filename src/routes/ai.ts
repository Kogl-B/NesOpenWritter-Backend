import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { z } from 'zod';

import { getProjectAccess } from '../lib/access.js';
import { resolveAccountStatus, STATUS_CATALOG } from '../lib/accountStatus.js';
import { chargedContinuityReceipts, continuityWalletAmounts } from '../lib/ai/continuityWallet.js';
import { completeSchema, validateComplete } from '../lib/ai/completeWork.js';
import { enqueueAiJob, readAiJob, type AiJobKind } from '../lib/ai/jobs.js';
import { ensureImageProvider, ensureProvider, periodStart, quotaFor, usageSince } from '../lib/ai/meter.js';
import { pricesForUsage, splitReceipt } from '../lib/ai/receipt.js';
import {
  DEFAULT_OPENAI_IMAGE_MODEL,
  MIN_IMAGE_BALANCE_CENTS,
  OPENAI_IMAGE_MODEL_TITLES,
  OPENAI_IMAGE_MODELS,
  isOpenAIImageModel,
  publicGeneration,
  readGeneration,
} from '../lib/ai/openaiImage.js';
import { prisma } from '../lib/prisma.js';

const imageSchema = z.object({
  prompt: z.string().trim().min(1).max(4000),
  mode: z.enum(OPENAI_IMAGE_MODELS).optional(),
  reference: z.string().trim().max(1_500_000).optional(),
  projectId: z.string().min(1).max(40).optional(),
});

const markSchema = z.object({
  projectId: z.string().min(1).max(40),
  target: z.enum(['chapter', 'character', 'item', 'location']),
  id: z.string().min(1).max(40),
  mark: z.enum(['created', 'reviewed']),
});

const jobSchema = z.object({
  kind: z.enum(['image', 'text', 'cover']),
  projectId: z.string().min(1).max(40).optional(),
  request: z.record(z.string(), z.unknown()).default({}),
});

function sendJobError(reply: FastifyReply, err: unknown) {
  const code = (err as { statusCode?: unknown } | null)?.statusCode;
  const status = typeof code === 'number' && Number.isInteger(code) && code >= 400 && code <= 599
    ? code : err instanceof z.ZodError ? 400 : 502;
  const message = err instanceof Error ? err.message : 'Генерация не удалась';
  return reply.status(status).send({ error: message });
}

export const aiRoutes: FastifyPluginAsync = async (app) => {
  app.get('/api/ai/usage', async (req) => {
    app.requireAuth(req);
    const status = await resolveAccountStatus(req.user!.id, req.user!.email);
    const provider = await ensureProvider();
    const spent = await usageSince(req.user!.id, periodStart());
    const limit = quotaFor(status, provider);
    const wallet = await continuityWalletAmounts(req.user!.id);
    return {
      ...wallet,
      status,
      statusTitle: STATUS_CATALOG[status].title,
      quota: { used: spent.tokens, limit, periodDays: 30 },
      tokens30: spent.tokens,
      costUsdMicros30: spent.costUsdMicros,
      requests30: spent.requests,
      enabled: provider.enabled && provider.keyCipher.length > 0,
    };
  });

  app.get('/api/ai/receipts', async (req) => {
    app.requireAuth(req);
    const query = z.object({
      page: z.coerce.number().int().min(1).optional(),
      limit: z.coerce.number().int().min(1).max(25).optional(),
    }).parse(req.query);
    const pageSize = Math.min(query.limit ?? 25, 25);
    const page = query.page ?? 1;
    const userId = req.user!.id;
    const [rows, total, providers] = await Promise.all([
      prisma.aiUsage.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.aiUsage.count({ where: { userId } }),
      prisma.aiProvider.findMany({
        select: { provider: true, inputMissUsdPerM: true, inputHitUsdPerM: true, outputUsdPerM: true },
      }),
    ]);
    const charges = await chargedContinuityReceipts(userId, rows.filter((row) => row.purpose === 'continuity-check').map((row) => row.id));
    const projectIds = [...new Set(rows.flatMap((row) => row.projectId ? [row.projectId] : []))];
    const projects = projectIds.length
      ? await prisma.project.findMany({ where: { id: { in: projectIds } }, select: { id: true, name: true } })
      : [];
    const nameOf = new Map(projects.map((project) => [project.id, project.name]));
    return {
      total,
      page,
      pageSize,
      receipts: rows.map((row) => {
        const prices = pricesForUsage(row.provider, row.model, providers);
        const parts = prices ? splitReceipt({
          cacheMissTokens: row.cacheMissTokens,
          cacheHitTokens: row.cacheHitTokens,
          completionTokens: row.completionTokens,
          costUsdMicros: row.costUsdMicros,
          prices,
        }) : null;
        return {
          id: row.id,
          at: row.createdAt.toISOString(),
          purpose: row.purpose,
          model: row.model,
          projectName: row.projectId ? (nameOf.get(row.projectId) ?? '') : '',
          peak: row.peak,
          cacheMissTokens: row.cacheMissTokens,
          cacheHitTokens: row.cacheHitTokens,
          completionTokens: row.completionTokens,
          totalTokens: row.totalTokens,
          costUsdMicros: row.costUsdMicros,
          chargedCents: charges.get(row.id) ?? null,
          inputMicros: parts?.inputMicros ?? null,
          cacheMicros: parts?.cacheMicros ?? null,
          outputMicros: parts?.outputMicros ?? null,
        };
      }),
    };
  });

  app.post('/api/ai/complete', async (req, reply) => {
    app.requireAuth(req);
    const input = completeSchema.parse(req.body);
    if (input.purpose === 'timeline-extract') {
      return reply.status(400).send({ error: 'Откройте разбор хронологии опубликованной главы.' });
    }
    const problem = validateComplete(input);
    if (problem) return reply.status(400).send({ error: problem });
    try {
      const job = await enqueueAiJob({
        userId: req.user!.id,
        email: req.user!.email,
        kind: 'text',
        projectId: input.projectId ?? '',
        request: input,
      });
      return (await job.done).result;
    } catch (err) {
      return sendJobError(reply, err);
    }
  });

  app.get('/api/ai/image', async (req) => {
    app.requireAuth(req);
    const provider = await ensureImageProvider();
    const model = isOpenAIImageModel(provider.model) ? provider.model : DEFAULT_OPENAI_IMAGE_MODEL;
    return {
      enabled: provider.enabled && provider.keyCipher.length > 0,
      defaultMode: model,
      modes: OPENAI_IMAGE_MODELS.map((id) => ({ id, title: OPENAI_IMAGE_MODEL_TITLES[id] })),
      generation: publicGeneration(readGeneration(provider.generation, model)),
      minBalanceCents: MIN_IMAGE_BALANCE_CENTS,
    };
  });

  app.post('/api/ai/image', { bodyLimit: 2_000_000 }, async (req, reply) => {
    app.requireAuth(req);
    const input = imageSchema.parse(req.body);
    if (!input.projectId) return reply.status(400).send({ error: 'Откройте книгу: картинке некуда сохраниться' });
    try {
      const job = await enqueueAiJob({
        userId: req.user!.id,
        email: req.user!.email,
        kind: 'image',
        projectId: input.projectId ?? '',
        request: { ...input, deliver: { type: 'file', kind: 'other' } },
      });
      return (await job.done).result;
    } catch (err) {
      return sendJobError(reply, err);
    }
  });

  app.post('/api/ai/jobs', { bodyLimit: 2_000_000 }, async (req, reply) => {
    app.requireAuth(req);
    const input = jobSchema.parse(req.body);
    if (input.kind === 'text' && input.request.purpose === 'timeline-extract') {
      return reply.status(400).send({ error: 'Откройте разбор хронологии опубликованной главы.' });
    }
    const projectId = input.projectId ?? (typeof input.request.projectId === 'string' ? input.request.projectId : '');
    if ((input.kind === 'image' || input.kind === 'cover') && !projectId) {
      return reply.status(400).send({ error: 'Откройте книгу: картинке некуда сохраниться' });
    }
    if (projectId) {
      const role = await getProjectAccess(projectId, req.user!.id);
      if (!role || role === 'viewer') return reply.status(404).send({ error: 'Книга не найдена' });
    }
    try {
      const job = await enqueueAiJob({
        userId: req.user!.id,
        email: req.user!.email,
        kind: input.kind as AiJobKind,
        projectId,
        request: input.request,
      });
      // Опрос читает итог из БД. Ошибка задачи не должна становиться необработанным Promise.
      void job.done.catch((err: unknown) => {
        req.log.error({ err, jobId: job.id, projectId, code: 'AI_JOB_FAILED' }, 'Фоновая задача ИИ завершилась ошибкой');
      });
      return { id: job.id, status: 'queued' };
    } catch (err) {
      return sendJobError(reply, err);
    }
  });

  app.get<{ Params: { id: string } }>('/api/ai/jobs/:id', async (req, reply) => {
    app.requireAuth(req);
    const job = await readAiJob(req.user!.id, req.params.id);
    if (!job) return reply.status(404).send({ error: 'Генерация не найдена' });
    return job;
  });

  app.post('/api/ai/mark', async (req, reply) => {
    app.requireAuth(req);
    const input = markSchema.parse(req.body);
    const role = await getProjectAccess(input.projectId, req.user!.id);
    if (!role) return reply.status(404).send({ error: 'Книга не найдена' });
    const data = input.mark === 'created' ? { aiCreated: true } : { aiReviewed: true };
    const where = { id: input.id, projectId: input.projectId };
    const result = input.target === 'chapter'
      ? await prisma.chapter.updateMany({ where, data })
      : input.target === 'character'
        ? await prisma.character.updateMany({ where, data })
        : input.target === 'item'
          ? await prisma.item.updateMany({ where, data })
          : await prisma.location.updateMany({ where, data });
    if (result.count === 0) return reply.status(404).send({ error: 'Запись не найдена' });
    return { ok: true };
  });
};
