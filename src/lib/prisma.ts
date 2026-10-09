import { PrismaClient } from '@prisma/client';
import { env } from './env.js';

// --- DB query timing for metrics ---
// Счётчик инкрементируется client-extension'ом ($allOperations): комментарии
// про «оборачивание ключевых методов» раньше были неправдой — счётчики не
// росли, и /admin/metrics показывал нули. Per-request атрибуция
// (trackDbQuery/getDbStats) оставлена нулевой: требует AsyncLocalStorage;
// глобальных счётчиков достаточно для анализа медленных маршрутов.
const queryCount = { total: 0, totalMs: 0, slow: [] as Array<{ model: string; action: string; ms: number }> };

const base = new PrismaClient({
  log: env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
});

export const prisma = base.$extends({
  query: {
    $allOperations: async ({ model, operation, args, query }) => {
      const start = performance.now();
      const result = await query(args);
      const ms = performance.now() - start;
      queryCount.total++;
      queryCount.totalMs += ms;
      if (ms > 200 && queryCount.slow.length < 100) {
        queryCount.slow.push({ model: model ?? 'raw', action: operation, ms: Math.round(ms * 100) / 100 });
      }
      return result;
    },
  },
});

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
