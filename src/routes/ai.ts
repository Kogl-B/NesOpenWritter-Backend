import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import { getProjectAccess } from '../lib/access.js';
import { resolveAccountStatus, STATUS_CATALOG } from '../lib/accountStatus.js';
import { completeDeepSeek, type ChatMessage } from '../lib/ai/deepseek.js';
import { ensureProvider, periodStart, quotaFor, recordUsage, usageSince } from '../lib/ai/meter.js';
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
]);

const completeSchema = z.object({
  purpose: purposeSchema,
  instruction: z.string().trim().max(2000).default(''),
  context: z.string().max(8000).default(''),
  selection: z.string().max(8000).default(''),
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
        maxTokens: CHECKS.has(input.purpose) || input.purpose === 'ask' ? 700 : input.purpose.endsWith('-create') ? 400 : 700,
        temperature: CHECKS.has(input.purpose) || input.purpose === 'ask' ? 0.3 : 0.8,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'DeepSeek не ответил';
      return reply.status(502).send({ error: message });
    }
    const row = await recordUsage({
      userId: req.user!.id,
      projectId,
      model: provider.model,
      purpose: input.purpose,
      usage: result.usage,
      prices: provider,
      peakMultiplier: provider.peakMultiplier,
    });
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
