import { prisma } from './prisma.js';
import { maxSuggestions, suggestionDayMs, suggestionStatus } from './blogSuggestionPolicy.js';

type Pair = { readerId: string; authorId: string };
type SuggestionDb = Pick<typeof prisma, 'blogSuggestionLimit' | 'blogReport'>;

export async function withSuggestionPair<T>(pair: Pair, work: (tx: SuggestionDb, now: Date) => Promise<T>) {
  return prisma.$transaction(async (tx) => {
    const key = JSON.stringify(['blog-suggestion', pair.readerId, pair.authorId]);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
    return work(tx, new Date());
  });
}

export async function readSuggestionLimit(db: SuggestionDb, pair: Pair, now: Date) {
  const limit = await db.blogSuggestionLimit.findUnique({ where: { readerId_authorId: pair } });
  const cutoff = new Date(Math.max(now.getTime() - suggestionDayMs, limit?.resetAt?.getTime() ?? 0));
  const latest = await db.blogReport.findMany({
    where: { userId: pair.readerId, kind: 'suggestion', createdAt: { gt: cutoff }, post: { authorId: pair.authorId } },
    orderBy: { createdAt: 'desc' },
    take: maxSuggestions,
    select: { createdAt: true },
  });
  return { status: suggestionStatus(now, { count: latest.length, latest: latest[0]?.createdAt }, limit), count: latest.length };
}

export function updateSuggestionLimit(
  tx: SuggestionDb,
  pair: Pair,
  dates: { blockedUntil?: Date | null; requestedAt?: Date | null; resetAt?: Date },
) {
  return tx.blogSuggestionLimit.upsert({
    where: { readerId_authorId: pair },
    create: { ...pair, ...dates },
    update: dates,
  });
}
