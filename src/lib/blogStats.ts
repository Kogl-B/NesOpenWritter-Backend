import { Prisma } from '@prisma/client';
import { prisma } from './prisma.js';
import { activeAuthors } from './authorSubscriptions.js';

async function blogAudienceCounts(authorId: string, now: Date, postId?: string) {
  const postFilter = postId ? Prisma.sql`AND id = ${postId}` : Prisma.empty;
  const [counts] = await prisma.$queryRaw<Array<{
      readers: number; subscriberReaders: number; subscriberViews: number; otherViews: number; views: number;
    }>>`
      WITH posts AS (
        SELECT id, views FROM blog_posts WHERE "authorId" = ${authorId} ${postFilter}
      ), readers AS (
        SELECT r."readerKey", SUM(r."subscriberViews") AS subscriber_views, SUM(r."otherViews") AS other_views
        FROM blog_post_readers r
        JOIN posts p ON p.id = r."postId"
        GROUP BY r."readerKey"
      )
      SELECT COUNT(*)::int AS readers,
             COUNT(s."userId")::int AS "subscriberReaders",
             COALESCE(SUM(r.subscriber_views), 0)::float8 AS "subscriberViews",
             COALESCE(SUM(r.other_views), 0)::float8 AS "otherViews",
             (SELECT COALESCE(SUM(views), 0)::float8 FROM posts) AS views
      FROM readers r
      LEFT JOIN author_subscriptions s
        ON s."authorId" = ${authorId} AND s."userId" = split_part(r."readerKey", ':', 2)
        AND r."readerKey" LIKE 'u:%'
        AND (s."expiresAt" IS NULL OR s."expiresAt" > ${now})
    `;
  return counts!;
}

export async function blogStats(authorId: string) {
  const now = new Date();
  const [audience, followers, subscribers, earnings, subscriptions] = await Promise.all([
    blogAudienceCounts(authorId, now),
    prisma.authorFollow.count({ where: { authorId } }),
    prisma.authorSubscription.count({ where: { authorId, ...activeAuthors(now) } }),
    prisma.blogWalletDonation.aggregate({
      where: { authorId }, _sum: { amountCents: true }, _count: { _all: true },
    }),
    prisma.blogAudienceEvent.aggregate({ where: { authorId, amountCents: { gt: 0 } }, _sum: { amountCents: true } }),
  ]);
  return {
    ...audience,
    followers,
    subscribers,
    donations: earnings._count._all,
    donationCents: earnings._sum.amountCents ?? 0,
    subscriptionCents: subscriptions._sum.amountCents ?? 0,
  };
}

export async function singlePostStats(authorId: string, postId: string) {
  const post = await prisma.blogPost.findFirst({
    where: { id: postId, authorId },
    select: { _count: { select: { likes: true, comments: true } } },
  });
  if (!post) return null;
  const [audience, earnings] = await Promise.all([
    blogAudienceCounts(authorId, new Date(), postId),
    prisma.blogWalletDonation.aggregate({
      where: { authorId, postId }, _sum: { amountCents: true }, _count: { _all: true },
    }),
  ]);
  return {
    ...audience,
    likes: post._count.likes,
    comments: post._count.comments,
    donations: earnings._count._all,
    donationCents: earnings._sum.amountCents ?? 0,
  };
}
