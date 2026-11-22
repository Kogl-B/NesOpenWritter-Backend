import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import { getProjectAccess } from '../lib/access.js';
import { resolveAccountStatus, STATUS_CATALOG } from '../lib/accountStatus.js';
import { completeDeepSeek, costUsdMicros, isPeakHour, withMarkup, type ChatMessage } from '../lib/ai/deepseek.js';
import { ensureImageProvider, ensureProvider, periodStart, quotaFor, recordUsage, takeAiCents, usageSince } from '../lib/ai/meter.js';
import { pricesForUsage, splitReceipt } from '../lib/ai/receipt.js';
import {
  DEFAULT_OPENAI_IMAGE_MODEL,
  MIN_IMAGE_BALANCE_CENTS,
  OPENAI_IMAGE_MODEL_TITLES,
  OPENAI_IMAGE_MODELS,
  centsFromMicros,
  generateImageViaOpenAI,
  imageCostUsdMicros,
  imageTokenCounts,
  isOpenAIImageModel,
  normalizeImageModel,
  publicGeneration,
  readGeneration,
  splitOpenAIKeys,
} from '../lib/ai/openaiImage.js';
import { openSecret } from '../lib/ai/secret.js';
import { prisma } from '../lib/prisma.js';

const purposeSchema = z.enum([
  'continue',
  'rewrite',
  'ask',
  'chapter-write',
  'character-create',
  'item-create',
  'location-create',
  'chapter-check',
  'character-check',
  'item-check',
  'location-check',
  'world-table',
]);

const completeSchema = z.object({
  purpose: purposeSchema,
  instruction: z.string().trim().max(2000).default(''),
  context: z.string().max(20000).default(''),
  selection: z.string().max(8000).default(''),
  projectId: z.string().min(1).max(40).optional(),
});

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

const CHECKS = new Set(['chapter-check', 'character-check', 'item-check', 'location-check']);

const EDITOR = 'Ты штатный редактор рукописи. Пиши по-русски. Верни только запрошенный текст: без предисловия, без пояснений и без кавычек вокруг всего ответа.';

function imagePay(settings: unknown): { enabled: boolean; limitMicros: number | null } {
  if (!settings || typeof settings !== 'object') return { enabled: false, limitMicros: null };
  const pay = (settings as { aiPay?: unknown }).aiPay;
  if (!pay || typeof pay !== 'object') return { enabled: false, limitMicros: null };
  const limits = (pay as { limits?: unknown }).limits;
  const raw = limits && typeof limits === 'object' ? (limits as { images?: unknown }).images : null;
  const limitMicros = typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? Math.round(raw * 1_000_000) : null;
  return { enabled: (pay as { useWallet?: unknown }).useWallet === true, limitMicros };
}

function referenceImage(value: string | undefined): string | undefined {
  const trimmed = value?.trim() ?? '';
  if (!trimmed) return undefined;
  if (/^https:\/\//i.test(trimmed) && trimmed.length <= 2000) return trimmed;
  if (/^data:image\/(png|jpeg|webp);base64,[a-z0-9+/=\s]+$/i.test(trimmed)) return trimmed.replace(/\s/g, '');
  throw new Error('Образец — ссылка https или файл PNG, JPEG, WebP');
}

function wish(instruction: string): string {
  return instruction ? `Пожелание: ${instruction}\n\n` : '';
}

function cardPrompt(kind: string, instruction: string): string {
  return `Придумай ${kind} для книги. Ответ строго в двух строках:\nНазвание: короткое имя\nТекст: две-четыре фразы.\n\n${wish(instruction)}`;
}

function checkPrompt(kind: string, instruction: string, body: string): string {
  return `Проверь согласованность: ${kind}. Не переписывай карточку и не пиши новый текст. Короткий список замечаний.\n\n${wish(instruction)}Карточка:\n${body}`;
}

function messages(input: z.infer<typeof completeSchema>): ChatMessage[] {
  const body = input.selection || input.context || '(пусто)';
  if (input.purpose === 'continue' || input.purpose === 'chapter-write') {
    return [
      { role: 'system', content: EDITOR },
      {
        role: 'user',
        content: `Напиши следующий кусок главы с места, где текст оборвался. Сохрани голос. Две-восемь фраз. Верни только текст главы.\n\n${wish(input.instruction)}Текст:\n${input.context || '(текст пуст)'}`,
      },
    ];
  }
  if (input.purpose === 'rewrite') {
    return [
      { role: 'system', content: EDITOR },
      {
        role: 'user',
        content: `Перепиши фрагмент. Смысл сохрани, если пожелание не просит иного. Верни только текст.\n\n${wish(input.instruction)}Фрагмент:\n${body}`,
      },
    ];
  }
  if (input.purpose === 'character-create') {
    return [{ role: 'system', content: EDITOR }, { role: 'user', content: cardPrompt('персонажа', input.instruction) }];
  }
  if (input.purpose === 'item-create') {
    return [{ role: 'system', content: EDITOR }, { role: 'user', content: cardPrompt('предмет', input.instruction) }];
  }
  if (input.purpose === 'location-create') {
    return [{ role: 'system', content: EDITOR }, { role: 'user', content: cardPrompt('локацию', input.instruction) }];
  }
  if (input.purpose === 'chapter-check') {
    return [
      { role: 'system', content: 'Ты проверяющий редактор. Отвечай по-русски списком замечаний. Новый текст главы не пиши.' },
      { role: 'user', content: checkPrompt('текст главы', input.instruction, body) },
    ];
  }
  if (input.purpose === 'character-check') {
    return [
      { role: 'system', content: 'Ты проверяющий редактор. Отвечай по-русски списком замечаний. Карточку не переписывай.' },
      { role: 'user', content: checkPrompt('персонаж', input.instruction, body) },
    ];
  }
  if (input.purpose === 'item-check') {
    return [
      { role: 'system', content: 'Ты проверяющий редактор. Отвечай по-русски списком замечаний. Карточку не переписывай.' },
      { role: 'user', content: checkPrompt('предмет', input.instruction, body) },
    ];
  }
  if (input.purpose === 'location-check') {
    return [
      { role: 'system', content: 'Ты проверяющий редактор. Отвечай по-русски списком замечаний. Карточку не переписывай.' },
      { role: 'user', content: checkPrompt('локация', input.instruction, body) },
    ];
  }
  if (input.purpose === 'world-table') {
    return [
      { role: 'system', content: 'Ты раскладываешь материал автора в одну таблицу. Ответ — только JSON без пояснений и без markdown.' },
      {
        role: 'user',
        content: `Собери одну таблицу из этой части материала. Не выдумывай строки. Одна строка — одна сущность из текста. Ячейка короче 120 знаков. Не больше 60 строк. JSON закрой целиком: {"title":"название","columns":[{"name":"столбец","kind":"text"}],"rows":[["значение"]]}. kind только text, number, date, datetime, checkbox. Дата — ГГГГ-ММ-ДД. Число — цифрами без пробелов. Пустая ячейка — пустая строка. Длина каждой строки равна числу столбцов.\n\n${wish(input.instruction)}Материал:\n${input.context || '(пусто)'}`,
      },
    ];
  }
  return [
    { role: 'system', content: 'Ты штатный помощник автора. Отвечай по-русски, коротко и по делу. Этот ответ не помечает книгу.' },
    {
      role: 'user',
      content: `${input.instruction}${input.context ? `\n\nТекст:\n${input.context}` : ''}${input.selection ? `\n\nВыделено:\n${input.selection}` : ''}`,
    },
  ];
}

export const aiRoutes: FastifyPluginAsync = async (app) => {
  app.get('/api/ai/usage', async (req) => {
    app.requireAuth(req);
    const status = await resolveAccountStatus(req.user!.id, req.user!.email);
    const provider = await ensureProvider();
    const spent = await usageSince(req.user!.id, periodStart());
    const limit = quotaFor(status, provider);
    return {
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
    const query = z.object({ limit: z.coerce.number().int().min(1).max(100).optional() }).parse(req.query);
    const limit = query.limit ?? 50;
    const userId = req.user!.id;
    const [rows, total, providers] = await Promise.all([
      prisma.aiUsage.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: limit,
      }),
      prisma.aiUsage.count({ where: { userId } }),
      prisma.aiProvider.findMany({
        select: { provider: true, inputMissUsdPerM: true, inputHitUsdPerM: true, outputUsdPerM: true },
      }),
    ]);
    const projectIds = [...new Set(rows.flatMap((row) => row.projectId ? [row.projectId] : []))];
    const projects = projectIds.length
      ? await prisma.project.findMany({ where: { id: { in: projectIds } }, select: { id: true, name: true } })
      : [];
    const nameOf = new Map(projects.map((project) => [project.id, project.name]));
    return {
      total,
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
    if (input.purpose === 'ask' && !input.instruction) {
      return reply.status(400).send({ error: 'Напишите вопрос' });
    }
    if (input.purpose === 'rewrite' && !input.selection && !input.context) {
      return reply.status(400).send({ error: 'Выделите фрагмент в рукописи' });
    }
    if (CHECKS.has(input.purpose) && !input.context && !input.selection) {
      return reply.status(400).send({ error: 'Нечего проверять' });
    }
    if (input.purpose !== 'world-table' && input.context.length > 8000) {
      return reply.status(400).send({ error: 'Слишком длинный текст' });
    }
    if (input.purpose === 'world-table' && !input.context.trim()) {
      return reply.status(400).send({ error: 'В файле нет текста для таблицы' });
    }
    const status = await resolveAccountStatus(req.user!.id, req.user!.email);
    const provider = await ensureProvider();
    if (!provider.enabled || !provider.keyCipher) {
      return reply.status(503).send({ error: 'Администратор ещё не подключил DeepSeek' });
    }
    const since = periodStart();
    const spent = await usageSince(req.user!.id, since);
    const limit = quotaFor(status, provider);
    if (limit != null && spent.tokens >= limit) {
      return reply.status(403).send({
        error: `Квота ИИ на 30 дней исчерпана: ${spent.tokens} из ${limit} токенов`,
      });
    }
    let projectId: string | null = null;
    if (input.projectId) {
      const role = await getProjectAccess(input.projectId, req.user!.id);
      if (role) projectId = input.projectId;
    }
    let apiKey: string;
    try {
      apiKey = openSecret(provider.keyCipher);
    } catch {
      return reply.status(500).send({ error: 'Ключ ИИ не читается. Сохраните его заново в админке.' });
    }
    let result: Awaited<ReturnType<typeof completeDeepSeek>>;
    try {
      result = await completeDeepSeek({
        baseUrl: provider.baseUrl,
        apiKey,
        model: provider.model,
        messages: messages(input),
        maxTokens: input.purpose === 'world-table' ? 8000 : CHECKS.has(input.purpose) || input.purpose === 'ask' ? 700 : input.purpose.endsWith('-create') ? 400 : 700,
        temperature: input.purpose === 'world-table' || CHECKS.has(input.purpose) || input.purpose === 'ask' ? 0.2 : 0.8,
        timeoutMs: input.purpose === 'world-table' ? 120_000 : undefined,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'DeepSeek не ответил';
      return reply.status(502).send({ error: message });
    }
    const real = costUsdMicros(result.usage, provider, isPeakHour(), provider.peakMultiplier);
    const charged = withMarkup(real, provider.chargeMultiplier);
    const row = await recordUsage({
      userId: req.user!.id,
      projectId,
      model: provider.model,
      purpose: input.purpose,
      usage: result.usage,
      prices: provider,
      peakMultiplier: provider.peakMultiplier,
      costUsdMicros: charged,
    });
    const pay = imagePay((await prisma.user.findUnique({
      where: { id: req.user!.id },
      select: { settings: true },
    }))?.settings);
    if (pay.enabled && charged > 0) await takeAiCents(req.user!.id, Math.max(1, Math.ceil(charged / 10_000)));
    const next = await usageSince(req.user!.id, since);
    return {
      text: result.text,
      usage: {
        totalTokens: row.totalTokens,
        costUsdMicros: row.costUsdMicros,
        peak: row.peak,
      },
      quota: { used: next.tokens, limit, periodDays: 30 },
    };
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
    let reference: string | undefined;
    try {
      reference = referenceImage(input.reference);
    } catch (err) {
      return reply.status(400).send({ error: err instanceof Error ? err.message : 'Образец не подходит' });
    }
    const provider = await ensureImageProvider();
    if (!provider.enabled || !provider.keyCipher) {
      return reply.status(503).send({ error: 'Администратор ещё не подключил генерацию картинок' });
    }
    const mode = input.mode ?? (isOpenAIImageModel(provider.model) ? provider.model : DEFAULT_OPENAI_IMAGE_MODEL);
    const account = await prisma.user.findUnique({
      where: { id: req.user!.id },
      select: { aiBalanceCents: true, settings: true },
    });
    const pay = imagePay(account?.settings);
    if (!pay.enabled) {
      return reply.status(402).send({ error: 'В кабинете включите «Использовать кошелёк для оплаты ИИ»' });
    }
    const balance = account?.aiBalanceCents ?? 0;
    if (balance < MIN_IMAGE_BALANCE_CENTS) {
      return reply.status(402).send({
        error: `Для картинки нужно не меньше ${(MIN_IMAGE_BALANCE_CENTS / 100).toFixed(2)} $ на балансе ИИ`,
      });
    }
    const since = periodStart();
    const cap = pay.limitMicros;
    if (cap != null) {
      const spent = await prisma.aiUsage.aggregate({
        where: { userId: req.user!.id, provider: 'openai-image', createdAt: { gte: since } },
        _sum: { costUsdMicros: true },
      });
      if ((spent._sum.costUsdMicros ?? 0) >= cap) {
        return reply.status(403).send({ error: 'Месячный лимит генерации картинок исчерпан' });
      }
    }
    let projectId: string | null = null;
    if (input.projectId) {
      const role = await getProjectAccess(input.projectId, req.user!.id);
      if (role) projectId = input.projectId;
    }
    let keys: string[];
    try {
      keys = splitOpenAIKeys(openSecret(provider.keyCipher));
    } catch {
      return reply.status(500).send({ error: 'Ключ OpenAI не читается. Сохраните его заново в админке.' });
    }
    let result: Awaited<ReturnType<typeof generateImageViaOpenAI>>;
    try {
      result = await generateImageViaOpenAI({
        apiKeys: keys,
        prompt: input.prompt,
        options: readGeneration(provider.generation, mode),
        referenceImage: reference,
        endUserId: req.user!.id,
        baseUrl: provider.baseUrl,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'OpenAI не вернул картинку';
      return reply.status(502).send({ error: message });
    }
    const measured = imageCostUsdMicros(result.usage, {
      textUsdPerM: provider.inputMissUsdPerM,
      imageInUsdPerM: provider.inputHitUsdPerM,
      imageOutUsdPerM: provider.outputUsdPerM,
    });
    const costUsdMicros = withMarkup(measured && measured > 0 ? measured : 100_000, provider.chargeMultiplier);
    const cents = Math.max(1, centsFromMicros(costUsdMicros));
    const chargedCents = await takeAiCents(req.user!.id, cents);
    const tokens = imageTokenCounts(result.usage);
    await recordUsage({
      userId: req.user!.id,
      projectId,
      model: normalizeImageModel(mode),
      purpose: reference ? 'image-edit' : 'image',
      usage: {
        promptTokens: tokens.promptTokens,
        completionTokens: tokens.completionTokens,
        totalTokens: tokens.totalTokens,
        cacheHitTokens: 0,
        cacheMissTokens: tokens.promptTokens,
      },
      prices: provider,
      peakMultiplier: 1,
      provider: 'openai-image',
      costUsdMicros,
    });
    const left = await prisma.user.findUnique({
      where: { id: req.user!.id },
      select: { aiBalanceCents: true },
    });
    return {
      src: `data:${result.mediaType};base64,${result.bytes.toString('base64')}`,
      mode: normalizeImageModel(mode),
      costUsdMicros,
      chargedCents,
      balanceCents: left?.aiBalanceCents ?? 0,
    };
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
