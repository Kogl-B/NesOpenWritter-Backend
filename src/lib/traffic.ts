import { prisma } from './prisma.js';

export const VISIT_AREAS = [
  'home',
  'search',
  'tops',
  'book',
  'reader',
  'forum',
  'blog',
  'editor',
  'account',
  'admin',
  'auth',
  'other',
] as const;

export type VisitArea = (typeof VISIT_AREAS)[number];

export function isVisitArea(value: unknown): value is VisitArea {
  return typeof value === 'string' && (VISIT_AREAS as readonly string[]).includes(value);
}

export function dayKey(value = new Date()): string {
  return value.toISOString().slice(0, 10);
}

export function safeAdHref(href: string): boolean {
  if (href.startsWith('/') && !href.startsWith('//')) return true;
  try {
    return new URL(href).protocol === 'https:';
  } catch {
    return false;
  }
}

const recent = new Map<string, number>();

/** Короткий замок в памяти процесса. Адрес никуда не пишется. */
export function recentlySeen(key: string, windowMs: number): boolean {
  const now = Date.now();
  const prev = recent.get(key) ?? 0;
  if (now - prev < windowMs) return true;
  recent.set(key, now);
  if (recent.size > 4000) {
    const cutoff = now - windowMs;
    for (const [name, at] of recent) {
      if (at < cutoff) recent.delete(name);
    }
    if (recent.size > 4000) recent.clear();
  }
  return false;
}

let uniqueDay = '';
const uniqueVisitors = new Set<string>();

/** Один браузер за сутки. После перезапуска процесса счётчик может прибавить ещё раз. */
export function claimDailyUnique(marker: string, day: string): boolean {
  if (uniqueDay !== day) {
    uniqueDay = day;
    uniqueVisitors.clear();
  }
  if (uniqueVisitors.has(marker)) return false;
  if (uniqueVisitors.size >= 20000) return false;
  uniqueVisitors.add(marker);
  return true;
}

export async function bumpMetric(kind: string, bucket: string, by = 1): Promise<void> {
  const day = dayKey();
  await prisma.$executeRaw`
    INSERT INTO daily_metrics (day, kind, bucket, total)
    VALUES (${day}, ${kind}, ${bucket}, ${by})
    ON CONFLICT (day, kind, bucket)
    DO UPDATE SET total = daily_metrics.total + ${by}
  `;
}
