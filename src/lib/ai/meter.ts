import type { AccountStatus } from '../accountStatus.js';
import { prisma } from '../prisma.js';
import { costUsdMicros, isPeakHour, type TokenUsage } from './deepseek.js';

const PERIOD_MS = 30 * 24 * 60 * 60 * 1000;

export function periodStart(now = new Date()): Date {
  return new Date(now.getTime() - PERIOD_MS);
}

export async function ensureProvider() {
  return prisma.aiProvider.upsert({
    where: { provider: 'deepseek' },
    update: {},
    create: {
      provider: 'deepseek',
      label: 'DeepSeek',
    },
  });
}

export async function ensureImageProvider() {
  const row = await prisma.aiProvider.upsert({
    where: { provider: 'openai-image' },
    update: {},
    create: {
      provider: 'openai-image',
      label: 'OpenAI Image',
      baseUrl: 'https://api.openai.com',
      model: 'gpt-image-2.5-flare',
      inputMissUsdPerM: 5_000_000,
      inputHitUsdPerM: 8_000_000,
      outputUsdPerM: 30_000_000,
      peakMultiplier: 1,
      chargeMultiplier: 3,
    },
  });
  if (row.inputMissUsdPerM === 150_000 && row.inputHitUsdPerM === 3_000 && row.outputUsdPerM === 600_000) {
    return prisma.aiProvider.update({
      where: { provider: 'openai-image' },
      data: {
        inputMissUsdPerM: 5_000_000,
        inputHitUsdPerM: 8_000_000,
        outputUsdPerM: 30_000_000,
        peakMultiplier: 1,
      },
    });
  }
  return row;
}

export function quotaFor(status: AccountStatus, provider: { testQuota: number; regularQuota: number; adminQuota: number }): number | null {
  const raw = status === 'admin' ? provider.adminQuota : status === 'regular' ? provider.regularQuota : provider.testQuota;
  return raw > 0 ? raw : null;
}

export async function usageSince(userId: string, since: Date, db: Pick<typeof prisma, 'aiUsage'> = prisma) {
  const sum = await db.aiUsage.aggregate({
    where: { userId, createdAt: { gte: since } },
    _sum: { totalTokens: true, costUsdMicros: true },
    _count: true,
  });
  return {
    tokens: sum._sum.totalTokens ?? 0,
    costUsdMicros: sum._sum.costUsdMicros ?? 0,
    requests: sum._count,
  };
}

export async function recordUsage(input: {
  userId: string;
  projectId: string | null;
  model: string;
  purpose: string;
  usage: TokenUsage;
  prices: { inputMissUsdPerM: number; inputHitUsdPerM: number; outputUsdPerM: number };
  peakMultiplier: number;
  provider?: string;
  costUsdMicros?: number;
}, db: Pick<typeof prisma, 'aiUsage'> = prisma) {
  const provider = input.provider ?? 'deepseek';
  const peak = provider === 'deepseek' && isPeakHour();
  const cost = input.costUsdMicros != null
    ? input.costUsdMicros
    : costUsdMicros(input.usage, input.prices, peak, input.peakMultiplier);
  return db.aiUsage.create({
    data: {
      userId: input.userId,
      projectId: input.projectId,
      provider,
      model: input.model,
      purpose: input.purpose,
      promptTokens: input.usage.promptTokens,
      completionTokens: input.usage.completionTokens,
      cacheHitTokens: input.usage.cacheHitTokens,
      cacheMissTokens: input.usage.cacheMissTokens,
      totalTokens: input.usage.totalTokens,
      costUsdMicros: cost,
      peak,
    },
  });
}

/** Списать центы с долларового счёта ИИ. Если суммы не хватает, забирает остаток. */
export async function takeAiCents(userId: string, cents: number): Promise<number> {
  if (cents <= 0) return 0;
  const exact = await prisma.user.updateMany({
    where: { id: userId, aiBalanceCents: { gte: cents } },
    data: { aiBalanceCents: { decrement: cents } },
  });
  if (exact.count === 1) return cents;
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { aiBalanceCents: true } });
  const left = user?.aiBalanceCents ?? 0;
  if (left <= 0) return 0;
  const rest = await prisma.user.updateMany({
    where: { id: userId, aiBalanceCents: { gte: left } },
    data: { aiBalanceCents: { decrement: left } },
  });
  return rest.count === 1 ? left : 0;
}
