/**
 * Сбор метрик производительности бэкенда:
 * — Время каждого HTTP-запроса (по route + method)
 * — Количество запросов (total, по route, по status code)
 * — Память процесса (heapUsed, heapTotal, rss, external)
 * — Event loop lag
 * — Активные handles/requests
 * — Top-N медленных запросов
 * — Гистограмма времени ответа
 */

export interface RequestMetric {
  route: string;
  method: string;
  statusCode: number;
  durationMs: number;
  timestamp: number;
  dbQueries: number;
  dbTimeMs: number;
}

export interface RouteStats {
  route: string;
  method: string;
  count: number;
  totalMs: number;
  avgMs: number;
  minMs: number;
  maxMs: number;
  p50Ms: number;
  p95Ms: number;
  errorCount: number;
  dbQueries: number;
  dbTimeMs: number;
}

export interface SystemMetrics {
  uptimeSec: number;
  memory: {
    heapUsedMB: number;
    heapTotalMB: number;
    rssMB: number;
    externalMB: number;
  };
  eventLoopLagMs: number;
  activeHandles: number;
  activeRequests: number;
  cpuPercent: number;
}

export interface MetricsSnapshot {
  system: SystemMetrics;
  totals: {
    totalRequests: number;
    totalErrors: number;
    avgResponseMs: number;
    requestsPerMin: number;
  };
  topRoutes: RouteStats[];
  slowestRequests: RequestMetric[];
  errorRates: Array<{ route: string; method: string; errors: number; total: number; rate: number }>;
  histogram: { bucket: string; count: number }[];
}

// --- Internal state ---
const routeMap = new Map<string, RouteStats>();
const recentRequests: RequestMetric[] = [];
const MAX_RECENT = 200;
const MAX_ROUTES = 200;
// Кольцевой буфер длительностей на маршрут: p50/p95 считаются по последним
// окнам, а не по всей истории с.reset — иначе после reset проценты пустые,
// а без reset avg маскирует хвост (R11: p95-хвост был невидим в avg).
const routeDurations = new Map<string, number[]>();
const MAX_DURATIONS = 128;

let totalRequests = 0;
let totalErrors = 0;
let totalResponseMs = 0;
let requestsStartTime = Date.now();

// Histogram buckets (ms)
const BUCKETS = [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, Infinity];
const BUCKET_LABELS = ['<1ms', '1-5ms', '5-10ms', '10-25ms', '25-50ms', '50-100ms', '100-250ms', '250-500ms', '500ms-1s', '1-2.5s', '2.5-5s', '>5s'];
const histogram = new Array(BUCKETS.length).fill(0);

// Event loop lag monitoring
let lastLagCheck = performance.now();
let currentLagMs = 0;

setInterval(() => {
  const now = performance.now();
  currentLagMs = now - lastLagCheck - 100; // subtract the 100ms interval
  lastLagCheck = now;
}, 100).unref();

// CPU usage (simplified)
let lastCpuUsage = process.cpuUsage();
let cpuPercent = 0;

setInterval(() => {
  const current = process.cpuUsage(lastCpuUsage);
  const totalMs = (current.user + current.system) / 1000;
  const elapsedMs = 5000; // 5s interval
  cpuPercent = Math.min(100, (totalMs / elapsedMs) * 100);
  lastCpuUsage = process.cpuUsage();
}, 5000).unref();

// --- Public API ---

export function recordRequest(metric: RequestMetric): void {
  totalRequests++;
  totalResponseMs += metric.durationMs;
  if (metric.statusCode >= 400) totalErrors++;

  // Histogram
  for (let i = 0; i < BUCKETS.length; i++) {
    if (metric.durationMs < BUCKETS[i]!) {
      histogram[i]++;
      break;
    }
  }

  // Route stats
  const key = `${metric.method} ${metric.route}`;
  let stats = routeMap.get(key);
  if (!stats) {
    if (routeMap.size >= MAX_ROUTES) return; // prevent unbounded growth
    stats = {
      route: metric.route,
      method: metric.method,
      count: 0,
      totalMs: 0,
      avgMs: 0,
      minMs: Infinity,
      maxMs: 0,
      p50Ms: 0,
      p95Ms: 0,
      errorCount: 0,
      dbQueries: 0,
      dbTimeMs: 0,
    };
    routeMap.set(key, stats);
  }

  stats.count++;
  stats.totalMs += metric.durationMs;
  stats.avgMs = stats.totalMs / stats.count;
  stats.minMs = Math.min(stats.minMs, metric.durationMs);
  stats.maxMs = Math.max(stats.maxMs, metric.durationMs);
  stats.dbQueries += metric.dbQueries;
  stats.dbTimeMs += metric.dbTimeMs;
  if (metric.statusCode >= 400) stats.errorCount++;

  const durations = routeDurations.get(key);
  if (durations) {
    durations.push(metric.durationMs);
    if (durations.length > MAX_DURATIONS) durations.shift();
  } else {
    routeDurations.set(key, [metric.durationMs]);
  }

  // Recent requests ring buffer
  recentRequests.push(metric);
  if (recentRequests.length > MAX_RECENT) recentRequests.shift();
}

export function getMetrics(): MetricsSnapshot {
  const mem = process.memoryUsage();
  const uptimeSec = Math.floor(process.uptime());

  // Sort routes by total time (descending) — top resource consumers
  const allRoutes = [...routeMap.values()].sort((a, b) => b.totalMs - a.totalMs);
  const topRoutes = allRoutes.slice(0, 20).map((r) => {
    const durations = (routeDurations.get(`${r.method} ${r.route}`) ?? []).slice().sort((a, b) => a - b);
    const pick = (q: number) => {
      if (durations.length === 0) return 0;
      const idx = Math.min(durations.length - 1, Math.floor(q * durations.length));
      return Math.round((durations[idx] ?? 0) * 100) / 100;
    };
    return {
      ...r,
      avgMs: Math.round(r.avgMs * 100) / 100,
      p50Ms: pick(0.5),
      p95Ms: pick(0.95),
    };
  });

  // Slowest recent requests
  const slowest = [...recentRequests]
    .sort((a, b) => b.durationMs - a.durationMs)
    .slice(0, 10);

  // Error rates
  const errorRates = allRoutes
    .filter((r) => r.errorCount > 0)
    .slice(0, 10)
    .map((r) => ({
      route: r.route,
      method: r.method,
      errors: r.errorCount,
      total: r.count,
      rate: Math.round((r.errorCount / r.count) * 10000) / 100,
    }));

  // Requests per minute
  const elapsedMin = Math.max(0.1, (Date.now() - requestsStartTime) / 60000);
  const requestsPerMin = Math.round(totalRequests / elapsedMin);

  return {
    system: {
      uptimeSec,
      memory: {
        heapUsedMB: Math.round((mem.heapUsed / 1024 / 1024) * 10) / 10,
        heapTotalMB: Math.round((mem.heapTotal / 1024 / 1024) * 10) / 10,
        rssMB: Math.round((mem.rss / 1024 / 1024) * 10) / 10,
        externalMB: Math.round((mem.external / 1024 / 1024) * 10) / 10,
      },
      eventLoopLagMs: Math.round(currentLagMs * 10) / 10,
      activeHandles: (process as unknown as { _getActiveHandles?: () => unknown[] })._getActiveHandles?.().length ?? 0,
      activeRequests: (process as unknown as { _getActiveRequests?: () => unknown[] })._getActiveRequests?.().length ?? 0,
      cpuPercent: Math.round(cpuPercent * 10) / 10,
    },
    totals: {
      totalRequests,
      totalErrors,
      avgResponseMs: totalRequests > 0 ? Math.round((totalResponseMs / totalRequests) * 100) / 100 : 0,
      requestsPerMin,
    },
    topRoutes,
    slowestRequests: slowest,
    errorRates,
    histogram: BUCKET_LABELS.map((label, i) => ({ bucket: label, count: histogram[i] })),
  };
}

export function resetMetrics(): void {
  routeMap.clear();
  routeDurations.clear();
  recentRequests.length = 0;
  totalRequests = 0;
  totalErrors = 0;
  totalResponseMs = 0;
  histogram.fill(0);
  requestsStartTime = Date.now();
}

// --- Prisma query timing ---
const queryTimers = new Map<string, { start: number; count: number }>();

export function beginDbQuery(queryId: string): void {
  const existing = queryTimers.get(queryId);
  if (existing) {
    existing.count++;
  } else {
    queryTimers.set(queryId, { start: performance.now(), count: 1 });
  }
}

export function endDbQuery(queryId: string): { timeMs: number; count: number } {
  const timer = queryTimers.get(queryId);
  if (!timer) return { timeMs: 0, count: 0 };
  queryTimers.delete(queryId);
  return {
    timeMs: Math.round((performance.now() - timer.start) * 100) / 100,
    count: timer.count,
  };
}

// AsyncLocalStorage would be ideal, but for simplicity we use a per-request ID
const requestDbStats = new Map<string, { queries: number; timeMs: number }>();

export function trackDbQuery(requestId: string, durationMs: number): void {
  let stats = requestDbStats.get(requestId);
  if (!stats) {
    stats = { queries: 0, timeMs: 0 };
    requestDbStats.set(requestId, stats);
  }
  stats.queries++;
  stats.timeMs += durationMs;
}

export function getDbStats(requestId: string): { queries: number; timeMs: number } {
  const stats = requestDbStats.get(requestId) ?? { queries: 0, timeMs: 0 };
  requestDbStats.delete(requestId);
  return stats;
}
