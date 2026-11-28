import { z } from 'zod';

import { getUserPlan, getStorageUsedBytes } from '../../routes/account.js';
import { prisma } from '../prisma.js';
import { isR2Configured, putPublicObject } from '../r2.js';
import { env } from '../env.js';
import { rememberStoredFile } from '../storedFileSync.js';
import { getTier, MB } from '../tiers.js';
import { lockProjectSettings } from '../projectSettings.js';
import { logger } from '../logger.js';
import { AiHttpError } from './aiError.js';
import { withMarkup } from './deepseek.js';
import { ensureImageProvider, periodStart, recordUsage, takeAiCents } from './meter.js';
import {
  DEFAULT_OPENAI_IMAGE_MODEL,
  OPENAI_IMAGE_MODELS,
  aiBalanceRefusal,
  centsFromMicros,
  generateImageViaOpenAI,
  imageCostUsdMicros,
  imageTokenCounts,
  isOpenAIImageModel,
  normalizeImageModel,
  readGeneration,
  splitOpenAIKeys,
} from './openaiImage.js';
import { openSecret } from './secret.js';
import { placeCoverInSettings, placePhotoInSettings } from './place.js';

const FILE_KINDS = ['portrait', 'item', 'map', 'other'] as const;

const deliverSchema = z.object({
  type: z.enum(['file', 'row-photo']),
  kind: z.enum(FILE_KINDS).optional(),
  tableId: z.string().min(1).max(80).optional(),
  rowId: z.string().min(1).max(80).optional(),
});

const imageRequestSchema = z.object({
  galleryArea: z.literal('manuscript').optional(),
  prompt: z.string().trim().min(1).max(4000),
  mode: z.enum(OPENAI_IMAGE_MODELS).optional(),
  reference: z.string().trim().max(1_500_000).optional(),
  projectId: z.string().min(1).max(40).optional(),
  deliver: deliverSchema.optional(),
});

const coverRequestSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().max(4000).default(''),
  mode: z.enum(['fresh', 'polish']).default('fresh'),
  reference: z.string().trim().max(1_500_000).optional(),
});

export interface ImageResult {
  href: string;
  src: string;
  mode: string;
  costUsdMicros: number;
  chargedCents: number;
  balanceCents: number;
  placed: boolean;
}

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
  throw new AiHttpError(400, 'Образец — ссылка https или файл PNG, JPEG, WebP');
}

function coverPrompt(title: string, description = ''): string {
  const name = title.trim().slice(0, 120) || 'Без названия';
  const about = description.trim().replace(/\s+/g, ' ').slice(0, 600);
  const story = about ? ` О чём книга: ${about}` : '';
  return `Книжная обложка. Название крупно и читаемо: «${name}». Вертикальный портрет, цельная сцена, без лишних надписей.${story}`.slice(0, 4000);
}

function coverPolishPrompt(title: string): string {
  const name = title.trim().slice(0, 120) || 'Без названия';
  return `Улучши эту обложку книги «${name}»: чище композиция, ровнее свет, название остаётся крупным и читаемым. Сюжет кадра сохрани.`.slice(0, 4000);
}

/** Отказ до вызова модели: кошелёк, баланс, хранилище и место тарифа. */
export async function refuseImageStart(userId: string): Promise<void> {
  const provider = await ensureImageProvider();
  if (!provider.enabled || !provider.keyCipher) {
    throw new AiHttpError(503, 'Администратор ещё не подключил генерацию картинок');
  }
  if (!isR2Configured() || !env.R2_PUBLIC_BASE_URL) {
    throw new AiHttpError(503, 'Хранилище картинок не настроено');
  }
  const account = await prisma.user.findUnique({
    where: { id: userId },
    select: { aiBalanceCents: true, settings: true },
  });
  const pay = imagePay(account?.settings);
  if (!pay.enabled) throw new AiHttpError(402, 'В кабинете включите «Использовать кошелёк для оплаты ИИ»');
  const refusal = aiBalanceRefusal(account?.aiBalanceCents ?? 0);
  if (refusal) throw new AiHttpError(402, refusal);
  const since = periodStart();
  if (pay.limitMicros != null) {
    const spent = await prisma.aiUsage.aggregate({
      where: { userId, provider: 'openai-image', createdAt: { gte: since } },
      _sum: { costUsdMicros: true },
    });
    if ((spent._sum.costUsdMicros ?? 0) >= pay.limitMicros) {
      throw new AiHttpError(403, 'Месячный лимит генерации картинок исчерпан');
    }
  }
  const tier = getTier(await getUserPlan(userId));
  if (tier.storageLimitMb != null) {
    const used = await getStorageUsedBytes(userId);
    if (used + 8 * MB > tier.storageLimitMb * MB) {
      throw new AiHttpError(403, `Недостаточно места тарифа «${tier.name}»: занято ${(used / MB).toFixed(1)} МБ из ${tier.storageLimitMb} МБ.`);
    }
  }
}

async function storeImage(input: {
  userId: string;
  projectId: string;
  kind: string;
  mediaType: string;
  bytes: Buffer;
}): Promise<string> {
  const tier = getTier(await getUserPlan(input.userId));
  if (tier.storageLimitMb != null) {
    const used = await getStorageUsedBytes(input.userId);
    if (used + input.bytes.length > tier.storageLimitMb * MB) {
      throw new AiHttpError(403, `Недостаточно места тарифа «${tier.name}», чтобы сохранить картинку.`);
    }
  }
  const ext = input.mediaType.includes('jpeg') ? 'jpg' : input.mediaType.includes('webp') ? 'webp' : 'png';
  const stored = await putPublicObject({
    userId: input.userId,
    projectId: input.projectId,
    kind: input.kind,
    filename: `photo.${ext}`,
    contentType: input.mediaType || 'image/png',
    body: input.bytes,
  });
  await rememberStoredFile({
    userId: input.userId,
    projectId: input.projectId,
    key: stored.key,
    sizeBytes: input.bytes.length,
    kind: input.kind,
  });
  return stored.publicUrl;
}

/** Рисует один кадр, кладёт его в хранилище и только потом списывает баланс. */
export async function performImage(userId: string, raw: unknown, projectId: string): Promise<ImageResult> {
  const input = imageRequestSchema.parse(raw);
  const bookId = projectId || input.projectId || '';
  if (!bookId) throw new AiHttpError(400, 'Откройте книгу: картинке некуда сохраниться');
  const reference = referenceImage(input.reference);
  await refuseImageStart(userId);
  const provider = await ensureImageProvider();
  const mode = input.mode ?? (isOpenAIImageModel(provider.model) ? provider.model : DEFAULT_OPENAI_IMAGE_MODEL);
  let keys: string[];
  try {
    keys = splitOpenAIKeys(openSecret(provider.keyCipher));
  } catch {
    throw new AiHttpError(500, 'Ключ OpenAI не читается. Сохраните его заново в админке.');
  }
  let drawn: Awaited<ReturnType<typeof generateImageViaOpenAI>>;
  try {
    drawn = await generateImageViaOpenAI({
      apiKeys: keys,
      prompt: input.prompt,
      options: readGeneration(provider.generation, mode),
      referenceImage: reference,
      endUserId: userId,
      baseUrl: provider.baseUrl,
    });
  } catch (err) {
    throw new AiHttpError(502, err instanceof Error ? err.message : 'OpenAI не вернул картинку');
  }
  const deliver = input.deliver ?? { type: 'file' as const };
  const kind = deliver.kind ?? 'other';
  const href = await storeImage({
    userId,
    projectId: bookId,
    kind,
    mediaType: drawn.mediaType,
    bytes: drawn.bytes,
  });
  let placed = deliver.type !== 'row-photo';
  if (deliver.type === 'row-photo' && deliver.tableId && deliver.rowId) {
    try {
      await lockProjectSettings(bookId, userId, (settings) => (
        placePhotoInSettings(settings, deliver.tableId ?? '', deliver.rowId ?? '', href)
      ));
      placed = true;
    } catch (err) {
      placed = false;
      logger.error({ err, userId, projectId: bookId }, 'Картинка сохранена, но в строку таблицы не встала');
    }
  }
  const measured = imageCostUsdMicros(drawn.usage, {
    textUsdPerM: provider.inputMissUsdPerM,
    imageInUsdPerM: provider.inputHitUsdPerM,
    imageOutUsdPerM: provider.outputUsdPerM,
  });
  const costUsdMicros = withMarkup(measured && measured > 0 ? measured : 100_000, provider.chargeMultiplier);
  const cents = Math.max(1, centsFromMicros(costUsdMicros));
  const chargedCents = await takeAiCents(userId, cents);
  const tokens = imageTokenCounts(drawn.usage);
  try {
    await recordUsage({
      userId,
      projectId: bookId,
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
  } catch (err) {
    logger.error({ err, userId }, 'Не удалось записать расход картинки');
  }
  const left = await prisma.user.findUnique({ where: { id: userId }, select: { aiBalanceCents: true } });
  return {
    href,
    src: href,
    mode: normalizeImageModel(mode),
    costUsdMicros,
    chargedCents,
    balanceCents: left?.aiBalanceCents ?? 0,
    placed,
  };
}

/** Рисует обложку и сразу улучшает её. Если второй кадр не вышел, остаётся первый. */
export async function performCover(userId: string, projectId: string, raw: unknown): Promise<Record<string, unknown>> {
  const input = coverRequestSchema.parse(raw);
  if (!projectId) throw new AiHttpError(400, 'Обложке нужна книга');
  let first: ImageResult | null = null;
  let polishError = '';
  if (input.mode === 'fresh') {
    first = await performImage(userId, {
      prompt: coverPrompt(input.title, input.description),
      projectId,
      deliver: { type: 'file', kind: 'other' },
    }, projectId);
  }
  const reference = input.mode === 'polish' ? input.reference : first?.href;
  if (!reference) throw new AiHttpError(400, 'Нет обложки, которую можно улучшить');
  let second: ImageResult | null = null;
  try {
    second = await performImage(userId, {
      prompt: coverPolishPrompt(input.title),
      projectId,
      reference,
      deliver: { type: 'file', kind: 'other' },
    }, projectId);
  } catch (err) {
    if (!first) throw err;
    polishError = err instanceof Error ? err.message : 'Не удалось улучшить обложку';
  }
  const chosen = second ?? first;
  if (!chosen) throw new AiHttpError(502, 'Обложка не получилась');
  let placed = false;
  try {
    await lockProjectSettings(projectId, userId, (settings) => placeCoverInSettings(settings, chosen.href));
    placed = true;
  } catch (err) {
    logger.error({ err, userId, projectId }, 'Обложка сохранена в хранилище, но не встала в книгу');
  }
  return {
    href: chosen.href,
    src: chosen.href,
    chargedCents: (first?.chargedCents ?? 0) + (second?.chargedCents ?? 0),
    balanceCents: chosen.balanceCents,
    polished: Boolean(second),
    polishError,
    placed,
  };
}
