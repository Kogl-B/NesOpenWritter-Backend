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

export function quotaFor(status: AccountStatus, provider: { testQuota: number; regularQuota: number; adminQuota: number }): number | null {
  const raw = status === 'admin' ? provider.adminQuota : status === 'regular' ? provider.regularQuota : provider.testQuota;
  return raw > 0 ? raw : null;
}

export async function usageSince(userId: string, since: Date) {
  const sum = await prisma.aiUsage.aggregate({
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
}) {
  const peak = isPeakHour();
  const cost = costUsdMicros(input.usage, input.prices, peak, input.peakMultiplier);
  return prisma.aiUsage.create({
    data: {
      userId: input.userId,
      projectId: input.projectId,
      provider: 'deepseek',
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
