import { createHash } from 'node:crypto';
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
const inFlight = new Map<string, Promise<void>>();

let cachedDay = '';
const storedBrowsersToday = new Set<string>();

export async function recordVisit(area: VisitArea, marker: string, browserId?: string): Promise<void> {
  const key = `view:${marker}:${area}`;
  await recordOnce(key, 1500, async () => {
    const day = dayKey();
    if (cachedDay !== day) {
      cachedDay = day;
      storedBrowsersToday.clear();
    }

    if (!browserId || storedBrowsersToday.has(browserId)) {
      await bumpMetric('view', area, day);
      return;
    }

    // The unique key is shared across processes. Both counters commit together.
    const hash = createHash('sha256').update(browserId).digest();
    await prisma.$executeRaw`
      WITH browser_visit AS (
        INSERT INTO daily_browser_visits (day, "browserHash") VALUES (${day}, ${hash})
        ON CONFLICT DO NOTHING
      )
      INSERT INTO daily_metrics (day, kind, bucket, total) VALUES (${day}, 'view', ${area}, 1)
      ON CONFLICT (day, kind, bucket) DO UPDATE SET total = daily_metrics.total + 1
    `;
    if (cachedDay === day && storedBrowsersToday.size < 20_000) storedBrowsersToday.add(browserId);
  });
}

export async function recordOnce(key: string, windowMs: number, record: () => Promise<void>): Promise<void> {
  const pending = inFlight.get(key);
  if (pending) return pending;
  if ((recent.get(key) ?? 0) > Date.now()) return;

  const request = Promise.resolve().then(record).then(() => {
    recent.delete(key);
    recent.set(key, Date.now() + windowMs);
    if (recent.size > 4000) {
      const oldest = recent.keys().next().value;
      if (oldest !== undefined) recent.delete(oldest);
    }
  });
  inFlight.set(key, request);
  try {
    await request;
  } finally {
    inFlight.delete(key);
  }
}

export async function bumpMetric(kind: string, bucket: string, day = dayKey()): Promise<void> {
  await prisma.$executeRaw`
    INSERT INTO daily_metrics (day, kind, bucket, total)
    VALUES (${day}, ${kind}, ${bucket}, 1)
    ON CONFLICT (day, kind, bucket) DO UPDATE SET total = daily_metrics.total + 1
  `;
}
