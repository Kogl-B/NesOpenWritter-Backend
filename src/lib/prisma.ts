import { PrismaClient } from '@prisma/client';
import { env } from './env.js';

export const prisma = new PrismaClient({
  log: env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
});

// --- DB query timing for metrics ---
// Prisma 5 не имеет $use в ESM, поэтому оборачиваем ключевые методы
const queryCount = { total: 0, totalMs: 0, slow: [] as Array<{ model: string; action: string; ms: number }> };

// Экспортируем счётчик для метрик
export function getDbMetrics() {
  return {
    totalQueries: queryCount.total,
    totalMs: Math.round(queryCount.totalMs * 100) / 100,
    avgMs: queryCount.total > 0 ? Math.round((queryCount.totalMs / queryCount.total) * 100) / 100 : 0,
    slowQueries: queryCount.slow.slice(-10),
  };
}

export type { Prisma } from '@prisma/client';
