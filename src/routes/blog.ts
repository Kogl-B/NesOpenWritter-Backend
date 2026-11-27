import sanitizeHtml from 'sanitize-html';
import { Prisma } from '@prisma/client';
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { prisma } from '../lib/prisma.js';
import { postBlocked } from '../lib/geo/policy.js';
import { countryBlocks, denyBlogGeo, denyGeo } from '../lib/geo/request.js';
import {
  blogDigestKey,
  blogPostNotices,
  blogReportNotice,
  commentNotices,
  digestDay,
  donationNotice,
  followNotice,
} from '../lib/notify/drafts.js';
import { writeDigest, writeNotices } from '../lib/notify/deliver.js';
import { viewerBlocks } from '../lib/viewerBlocks.js';
import { attachmentOptions, attachmentSchema, canAttach, publicAttachments, readAttachment, type AttachmentLink } from '../lib/blogAttachments.js';
import { blogStats, singlePostStats } from '../lib/blogStats.js';
import { previousBlogDonation, transferBlogDonation } from '../lib/blogWalletDonation.js';
import { coverHref } from '../lib/ai/place.js';
import { activeAuthors, buyAuthorSubscription, cancellationReasons, changeAuthorAccess, lockLevel, paymentSchema, quoteAuthorSubscription } from '../lib/authorSubscriptions.js';
import { lockWallets } from '../lib/wallet.js';
import { blogEarnings, earningsActivities, earningsListQuery, earningsPeriod, earningsSubscribers, exportBlogEarnings } from '../lib/blogEarnings.js';
import { requireAdmin } from '../lib/accountStatus.js';

const reactionEmoji = z.enum(['like', 'heart', 'fire', 'clap', 'smile', 'book']);
type Reaction = z.infer<typeof reactionEmoji>;
type ReactionCount = { emoji: string; count: number };
const feedbackKind = z.enum(['complaint', 'suggestion']);
const feedbackStatus = z.enum(['new', 'reviewed', 'resolved']);
const maxCommentFileSize = 5 * 1024 * 1024;
const maxCommentBase64 = Math.ceil(maxCommentFileSize / 3) * 4;
const maxCommentFiles = 3;
const commentFiles = { select: { id: true, name: true, size: true }, orderBy: { position: 'asc' } } as const;
const commentInput = z.object({
  body: z.string().trim().max(2000),
  parentId: z.string().trim().max(64).optional(),
  attachments: z.array(z.object({
    name: z.string().trim().min(1).max(255).refine((name) => !/[\p{Cc}\p{Cs}/\\]/u.test(name), 'Недопустимое имя файла'),
    base64: z.string(),
  })).max(maxCommentFiles).default([]),
}).refine((input) => input.body || input.attachments.length, 'Добавьте текст или файл');

const tagsSchema = z.array(z.string().trim().transform((tag) => tag.replace(/^#+\s*/u, '')).pipe(z.string().min(1).max(24))).max(8)
  .transform((tags) => [...new Map(tags.map((tag) => [tag.toLocaleLowerCase('ru-RU'), tag])).values()]);
const writeSchema = z.object({
  title: z.string().trim().min(1).max(160),
  body: z.string().trim().min(1).max(40_000),
  topic: z.string().trim().max(80).optional(),
  tags: tagsSchema.optional(),
  attachment: attachmentSchema.nullable().optional(),
  published: z.boolean().optional(),
  levelId: z.string().trim().max(40).nullable().optional(),
  audience: z.enum(['all', 'subscribers', 'level', 'self']).optional(),
  commentAccess: z.enum(['all', 'subscribers', 'none']).optional(),
  moderatorIds: z.array(z.string().trim().min(1).max(40)).max(12).optional(),
});
const levelSchema = z.object({
  title: z.string().trim().min(1).max(80),
  description: z.string().trim().max(500).optional(),
  priceRub: z.number().int().min(0).max(100_000),
  avatar: z.string().max(120_000).optional(),
  available: z.boolean().optional(),
});

const blogProfileSchema = z.object({
  nickname: z.string().trim().transform((value) => value.normalize('NFKC').toLowerCase())
    .refine((value) => value === '' || /^[\p{L}\p{N}_-]{3,32}$/u.test(value), 'Ник должен содержать от 3 до 32 букв, цифр, дефисов или подчёркиваний'),
  title: z.string().trim().max(100),
  description: z.string().trim().max(1000),
  defaultAudience: z.enum(['all', 'subscribers', 'self']),
  defaultCommentAccess: z.enum(['all', 'subscribers', 'none']),
});

const subscriptionSchema = z.object({ levelId: z.string().min(1).max(80).nullable() });
const trafficSource = z.enum(['direct', 'site', 'search', 'social', 'external', 'unknown']);
const blogProfileSelect = { nickname: true, title: true, description: true, defaultAudience: true, defaultCommentAccess: true } as const;
const publishedOrder: Prisma.BlogPostOrderByWithRelationInput[] = [
  { publishedAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }, { id: 'desc' },
];

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function asHtml(body: string): string {
  if (/<\/?[a-z][\s\S]*>/i.test(body)) return body;
  const blocks = body.split(/\n{2,}/).map((block) => block.trim()).filter(Boolean);
  if (blocks.length === 0) return '<p></p>';
  return blocks.map((block) => `<p>${escapeHtml(block).replace(/\n/g, '<br>')}</p>`).join('');
}

function plainText(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanHtml(input: string): string {
  return sanitizeHtml(asHtml(input), {
    allowedTags: ['p', 'br', 'strong', 'b', 'em', 'i', 'u', 's', 'h2', 'h3', 'ul', 'ol', 'li',
      'blockquote', 'a', 'code', 'pre', 'hr', 'span', 'img'],
    allowedAttributes: { a: ['href'], img: ['src', 'alt'] },
    allowedSchemes: ['http', 'https'],
    allowedSchemesByTag: { img: ['http', 'https', 'data'] },
    allowProtocolRelative: false,
    exclusiveFilter: (frame) => frame.tag === 'img' && !(
      /^(?:https?:\/\/|\/(?![\\/])|data:image\/(?:png|jpeg|webp|gif|avif);base64,)/i.test(frame.attribs.src ?? '')
    ),
  });
}

function avatarOk(value: string | undefined): boolean {
  if (!value) return true;
  return value.startsWith('data:image/') && value.length <= 120_000;
}

type PostRow = {
  id: string;
  authorId: string;
  title: string;
  body: string;
  topic: string;
  tags: string[];
  attachment: unknown;
  views: number;
  published: boolean;
  publishedAt: Date | null;
  levelId: string | null;
  audience: string;
  commentAccess: string;
  createdAt: Date;
  updatedAt: Date;
  author?: { name: string | null; image: string | null; blogProfile: { nickname: string | null } | null } | null;
  level?: { id: string; title: string; priceRub: number } | null;
  moderators?: { user: { id: string; name: string | null } }[];
  _count?: { comments: number; likes: number };
};

function canSee(post: PostRow, userId: string | undefined, price: number | null): boolean {
  if (userId && userId === post.authorId) return true;
  if (post.audience === 'self') return false;
  if (post.audience === 'subscribers') return price != null;
  if (post.audience === 'level' || post.levelId) return !!post.level && price != null && price >= post.level.priceRub;
  return true;
}

function canWriteComment(post: PostRow, userId: string | undefined, price: number | null, moderator: boolean): boolean {
  if (!userId || post.commentAccess === 'none' || !canSee(post, userId, price)) return false;
  if (userId === post.authorId || moderator) return true;
  if (post.commentAccess === 'subscribers') return price != null;
  return true;
}

function card(post: PostRow, extra: {
  liked?: boolean; locked?: boolean; chars?: number; canComment?: boolean; canModerate?: boolean;
  attachment?: AttachmentLink;
  reaction?: string | null;
  reactions?: ReactionCount[];
  own?: boolean;
} = {}) {
  const text = plainText(post.body);
  const locked = extra.locked === true;
  return {
    id: post.id,
    authorId: post.authorId,
    authorName: post.author?.name?.trim() || 'Автор',
    authorNickname: post.author?.blogProfile?.nickname ?? '',
    authorAvatar: coverHref(post.author?.image),
    title: post.title,
    body: locked ? '' : cleanHtml(post.body),
    excerpt: locked ? '' : text.slice(0, 280),
    topic: post.topic,
    tags: post.tags,
    attachment: extra.attachment ?? null,
    ...(extra.own && { attachmentChoice: readAttachment(post.attachment) }),
    views: post.views,
    chars: extra.chars ?? text.length,
    comments: post._count?.comments ?? 0,
    likes: extra.reactions?.reduce((sum, item) => sum + item.count, 0) ?? post._count?.likes ?? 0,
    liked: extra.liked ?? false,
    reaction: extra.reaction ?? null,
    reactions: extra.reactions ?? [],
    published: post.published,
    publishedAt: post.publishedAt?.toISOString() ?? (post.published ? post.createdAt.toISOString() : null),
    locked,
    levelId: post.levelId,
    levelTitle: post.level?.title ?? '',
    levelPriceRub: post.level?.priceRub ?? 0,
    audience: post.audience,
    commentAccess: post.commentAccess,
    canComment: extra.canComment ?? false,
    canModerate: extra.canModerate ?? false,
    moderators: (post.moderators ?? []).map((row) => ({
      id: row.user.id,
      name: row.user.name?.trim() || 'Без имени',
    })),
    createdAt: post.createdAt.toISOString(),
    updatedAt: post.updatedAt.toISOString(),
  };
}

const postInclude = {
  author: { select: { name: true, image: true, blogProfile: { select: { nickname: true } } } },
  level: { select: { id: true, title: true, priceRub: true } },
  _count: { select: { comments: true, likes: true } },
} as const;

async function accessPrice(userId: string | undefined, authorId: string): Promise<number | null> {
  if (!userId) return null;
  const sub = await prisma.authorSubscription.findFirst({
    where: { userId, authorId, ...activeAuthors() },
    include: { level: { select: { priceRub: true } } },
  });
  return sub ? sub.level.priceRub : null;
}

async function accessMap(userId: string | undefined, authorIds: string[]): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  if (!userId || authorIds.length === 0) return map;
  const rows = await prisma.authorSubscription.findMany({
    where: { userId, authorId: { in: authorIds }, ...activeAuthors() },
    include: { level: { select: { priceRub: true } } },
  });
  for (const row of rows) map.set(row.authorId, row.level.priceRub);
  return map;
}

const deskInclude = {
  ...postInclude,
  moderators: { include: { user: { select: { id: true, name: true } } } },
} as const;

async function moderatorIdsOf(authorId: string, ids: string[]): Promise<string[]> {
  const unique = [...new Set(ids.filter((id) => id && id !== authorId))].slice(0, 12);
  if (unique.length === 0) return [];
  const found = await prisma.user.findMany({ where: { id: { in: unique } }, select: { id: true } });
  const known = new Set(found.map((row) => row.id));
  return unique.filter((id) => known.has(id));
}

async function publishedCards(req: FastifyRequest, authorId?: string) {
  const geo = await countryBlocks(req);
  const posts = await prisma.blogPost.findMany({
    where: {
      published: true,
      ...(authorId ? { authorId } : {}),
      OR: [{ audience: { not: 'self' } }, ...(req.user ? [{ authorId: req.user.id }] : [])],
    },
    include: postInclude,
    orderBy: publishedOrder,
    take: 50,
  });
  const blocks = await viewerBlocks(req.user?.id ?? null);
  return visibleCards(posts, req.user?.id, geo, blocks);
}

async function visibleCards(
  posts: PostRow[],
  userId: string | undefined,
  geo: Awaited<ReturnType<typeof countryBlocks>>,
  blocks: Awaited<ReturnType<typeof viewerBlocks>>,
) {
  const visible = posts.filter((post) => (
    !postBlocked(geo.index, geo.country, post.id)
    && !blocks.blogs.has(post.id)
    && !blocks.people.has(post.authorId)
  ));
  const [prices, attachments, reactions] = await Promise.all([
    accessMap(userId, [...new Set(visible.map((post) => post.authorId))]),
    publicAttachments(visible, geo, blocks.books),
    postReactions(visible.map((post) => post.id), userId),
  ]);
  return visible.map((post) => card(post, {
    ...reactionSummary(reactions, post.id),
    locked: !canSee(post, userId, prices.get(post.authorId) ?? null),
    canComment: canWriteComment(post, userId, prices.get(post.authorId) ?? null, false),
    attachment: attachments.get(post.id),
  }));
}

const feedQuery = z.object({
  q: z.string().trim().max(160).optional(),
  author: z.string().trim().max(100).optional(),
  topic: z.string().trim().max(80).optional(),
  tag: z.string().max(600).optional(),
  excludeTag: z.string().max(600).optional(),
  days: z.enum(['1', '7', '30', '365']).optional(),
  audience: z.enum(['public', 'subscribers']).optional(),
  sort: z.enum(['latest', 'discussed', 'likes', 'views', 'oldest']).default('latest'),
  page: z.coerce.number().int().min(1).max(10000).default(1),
  limit: z.coerce.number().int().min(1).max(30).default(12),
});

function searchWord(value: string) {
  return value.trim().toLocaleLowerCase('ru-RU').replaceAll('ё', 'е');
}

function labelMatches(normalized: string) {
  return Prisma.sql`(replace(lower(b.topic), 'ё', 'е') = ${normalized}
    OR EXISTS (SELECT 1 FROM unnest(b.tags) AS tag WHERE replace(lower(tag), 'ё', 'е') = ${normalized}))`;
}

const publicationDate = Prisma.sql`COALESCE(b."publishedAt", b."createdAt")`;
const publishedForEveryone = Prisma.sql`b.audience = 'all' AND b."levelId" IS NULL`;
const byLikes = Prisma.sql`(SELECT count(*) FROM blog_likes AS l WHERE l."postId" = b.id) DESC`;
const feedOrder = {
  latest: Prisma.sql`${publicationDate} DESC`,
  oldest: Prisma.sql`${publicationDate} ASC`,
  likes: Prisma.sql`${byLikes}, ${publicationDate} DESC`,
  views: Prisma.sql`b.views DESC, ${publicationDate} DESC`,
  discussed: Prisma.sql`(SELECT count(*) FROM blog_comments AS c WHERE c."postId" = b.id) DESC, ${byLikes}, ${publicationDate} DESC`,
};

async function filteredFeed(req: FastifyRequest) {
  const input = feedQuery.parse(req.query);
  const userId = req.user?.id;
  const [geo, blocks] = await Promise.all([countryBlocks(req), viewerBlocks(userId ?? null)]);
  const hiddenIds = new Set(blocks.blogs);
  for (const [id, countries] of geo.index.posts) {
    if (geo.country && countries.has(geo.country)) hiddenIds.add(id);
  }
  const conditions = [
    Prisma.sql`b.published AND (b.audience <> 'self' OR b."authorId" = ${userId ?? ''})`,
  ];
  if (hiddenIds.size) conditions.push(Prisma.sql`b.id NOT IN (${Prisma.join([...hiddenIds])})`);
  if (blocks.people.size) conditions.push(Prisma.sql`b."authorId" NOT IN (${Prisma.join([...blocks.people])})`);
  if (input.audience === 'public') conditions.push(publishedForEveryone);
  if (input.audience === 'subscribers') conditions.push(Prisma.sql`b.audience <> 'self' AND NOT (${publishedForEveryone})`);
  if (input.days) conditions.push(Prisma.sql`${publicationDate} >= ${new Date(Date.now() - Number(input.days) * 86400000)}`);
  if (input.topic) conditions.push(labelMatches(searchWord(input.topic)));
  for (const tag of (input.tag ?? '').split(',').map(searchWord).filter(Boolean)) conditions.push(labelMatches(tag));
  for (const tag of (input.excludeTag ?? '').split(',').map(searchWord).filter(Boolean)) {
    conditions.push(Prisma.sql`NOT ${labelMatches(tag)}`);
  }
  const author = searchWord(input.author ?? '').replace(/^@/, '');
  const authorText = Prisma.sql`replace(lower(concat_ws(' ', u.name, bp.nickname, '@' || bp.nickname)), 'ё', 'е')`;
  if (author) conditions.push(Prisma.sql`strpos(${authorText}, ${author}) > 0`);
  const preview = Prisma.sql`left(trim(regexp_replace(regexp_replace(b.body, '<[^>]+>', ' ', 'g'), '[[:space:]]+', ' ', 'g')), 280)`;
  const searchText = Prisma.sql`replace(lower(concat_ws(' ', b.title, b.topic, array_to_string(b.tags, ' '), ${authorText}, ${preview})), 'ё', 'е')`;
  for (const term of searchWord(input.q ?? '').split(/\s+/).filter(Boolean)) {
    conditions.push(Prisma.sql`strpos(${searchText}, ${term}) > 0`);
  }
  const rows = await prisma.$queryRaw<{ id: string; total: number }[]>`
    SELECT b.id, count(*) OVER()::int AS total
    FROM blog_posts AS b
    JOIN users AS u ON u.id = b."authorId"
    LEFT JOIN blog_profiles AS bp ON bp."authorId" = u.id
    WHERE ${Prisma.join(conditions, ' AND ')}
    ORDER BY ${feedOrder[input.sort]}, b.id DESC
    LIMIT ${input.limit} OFFSET ${(input.page - 1) * input.limit}
  `;
  const ids = rows.map(({ id }) => id);
  const posts = await prisma.blogPost.findMany({
    where: { id: { in: ids }, published: true, OR: [{ audience: { not: 'self' } }, { authorId: userId ?? '' }] },
    include: postInclude,
  });
  const indexed = new Map(posts.map((post) => [post.id, post]));
  const ordered = ids.flatMap((id) => indexed.get(id) ?? []);
  return {
    posts: await visibleCards(ordered, userId, geo, blocks),
    total: rows[0]?.total ?? 0,
    page: input.page,
    hasNext: (rows[0]?.total ?? 0) > input.page * input.limit,
  };
}

async function postReactions(postIds: string[], userId?: string, db: Pick<typeof prisma, 'blogLike'> = prisma) {
  const where = { postId: { in: postIds } };
  const [totals, own] = await Promise.all([
    db.blogLike.groupBy({ by: ['postId', 'emoji'], where, _count: { _all: true } }),
    userId ? db.blogLike.findMany({ where: { ...where, userId }, select: { postId: true, emoji: true } }) : [],
  ]);
  const byPost = new Map<string, ReactionCount[]>();
  for (const row of totals) {
    const list = byPost.get(row.postId) ?? [];
    list.push({ emoji: row.emoji, count: row._count._all });
    byPost.set(row.postId, list);
  }
  for (const list of byPost.values()) {
    list.sort((a, b) => b.count - a.count
      || reactionEmoji.options.indexOf(a.emoji as Reaction) - reactionEmoji.options.indexOf(b.emoji as Reaction));
  }
  return { byPost, own: new Map(own.map((row) => [row.postId, row.emoji])) };
}

function reactionSummary(data: Awaited<ReturnType<typeof postReactions>>, postId: string) {
  const reaction = data.own.get(postId) ?? null;
  const reactions = data.byPost.get(postId) ?? [];
  return { reaction, reactions, liked: reaction !== null };
}

async function visibleToViewer(post: { id: string; audience: string; authorId: string }, userId?: string) {
  if (post.audience === 'self' && post.authorId !== userId) return false;
  const blocks = await viewerBlocks(userId ?? null);
  return !blocks.blogs.has(post.id) && !blocks.people.has(post.authorId);
}

async function changeReaction(app: FastifyInstance, req: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply, requested?: Reaction | null) {
  app.requireAuth(req);
  const userId = req.user!.id;
  const post = await prisma.blogPost.findFirst({
    where: { id: req.params.id, published: true },
    select: { id: true, authorId: true, title: true, audience: true },
  });
  if (!post || !await visibleToViewer(post, userId)) return reply.status(404).send({ error: 'Запись не найдена' });
  const key = { userId, postId: post.id };
  const result = await prisma.$transaction(async (tx) => {
    const [published] = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "blog_posts" WHERE "id" = ${post.id} AND "published" FOR UPDATE`;
    if (!published) return null;
    const existing = await tx.blogLike.findUnique({ where: { userId_postId: key }, select: { emoji: true } });
    const next = requested === undefined ? (existing ? null : 'heart') : requested;
    if (next && next !== existing?.emoji) {
      await tx.blogLike.upsert({ where: { userId_postId: key }, create: { ...key, emoji: next }, update: { emoji: next } });
    } else if (!next && existing) {
      await tx.blogLike.delete({ where: { userId_postId: key } });
    }
    const summary = reactionSummary(await postReactions([post.id], userId, tx), post.id);
    return { summary, joinedChanged: Boolean(existing) !== Boolean(next) };
  });
  if (!result) return reply.status(404).send({ error: 'Запись не найдена' });
  if (result.joinedChanged) await writeDigest({
    ownerId: post.authorId,
    actorId: userId,
    bucket: 'reactions',
    on: result.summary.liked,
    subject: post.title,
    href: '/blog/' + post.id,
    eventKey: blogDigestKey(post.id, digestDay(new Date())),
  });
  return { ...result.summary, likes: result.summary.reactions.reduce((sum, item) => sum + item.count, 0) };
}

export const blogRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', async (req, reply) => {
    if (await denyBlogGeo(req, reply)) return reply;
  });

  app.get('/api/blog', { config: { rateLimit: { max: 120 } } }, async (req) => ({ posts: await publishedCards(req) }));
  app.get('/api/blog/feed', { config: { rateLimit: { max: 120 } }, preHandler: [async (_req, reply) => { reply.header('Cache-Control', 'private, no-store'); }] }, filteredFeed);

  app.get<{ Params: { authorId: string }; Querystring: { posts?: string } }>('/api/blog/authors/:authorId', async (req) => {
    const author = await prisma.user.findUnique({
      where: { id: req.params.authorId },
      select: { id: true, name: true, blogProfile: { select: { nickname: true, title: true, description: true } } },
    });
    if (!author) return { author: null, levels: [], posts: [], following: false, subscribedLevelId: null, followers: 0 };
    const [levels, followers, follow, sub, posts] = await Promise.all([
      prisma.authorLevel.findMany({ where: { authorId: author.id }, orderBy: { priceRub: 'asc' } }),
      prisma.authorFollow.count({ where: { authorId: author.id } }),
      req.user ? prisma.authorFollow.findUnique({ where: { userId_authorId: { userId: req.user.id, authorId: author.id } } }) : null,
      req.user ? prisma.authorSubscription.findFirst({ where: { userId: req.user.id, authorId: author.id, ...activeAuthors() } }) : null,
      req.query.posts === '1' ? publishedCards(req, author.id) : [],
    ]);
    return {
      author: {
        id: author.id,
        name: author.name?.trim() || 'Автор',
        nickname: author.blogProfile?.nickname ?? '',
        title: author.blogProfile?.title ?? '',
        description: author.blogProfile?.description ?? '',
      },
      posts,
      followers,
      following: Boolean(follow),
      subscribedLevelId: sub?.levelId ?? null,
      subscribedUntil: sub?.expiresAt ?? null,
      subscriptionCancelled: Boolean(sub?.cancelledAt),
      levels: levels.map((level) => ({
        id: level.id,
        title: level.title,
        description: level.description,
        priceRub: level.priceRub,
        avatar: level.avatar,
        available: level.available,
      })),
    };
  });

  app.post<{ Params: { authorId: string } }>('/api/blog/authors/:authorId/follow', async (req) => {
    app.requireAuth(req);
    if (req.params.authorId === req.user!.id) return { following: false };
    const key = { userId: req.user!.id, authorId: req.params.authorId };
    const following = await prisma.$transaction(async (tx) => {
      if ((await lockWallets(tx, [key.userId, key.authorId])).length !== 2) return false;
      const removed = await tx.authorFollow.deleteMany({ where: key });
      if (removed.count) return false;
      await tx.authorFollow.create({ data: key });
      await tx.blogAudienceEvent.create({ data: { ...key, kind: 'followed' } });
      return true;
    });
    if (!following) return { following };
    const me = await prisma.user.findUnique({ where: { id: req.user!.id }, select: { name: true } });
    await writeNotices(followNotice({
      authorId: req.params.authorId,
      actorId: req.user!.id,
      actorName: me?.name?.trim() || 'Читатель',
    }));
    return { following: true };
  });

  app.get<{ Params: { authorId: string } }>('/api/blog/authors/:authorId/subscription-quote', async (req, reply) => {
    app.requireAuth(req);
    reply.header('Cache-Control', 'private, no-store');
    const { levelId } = z.object({ levelId: z.string().min(1).max(80) }).parse(req.query);
    const result = await quoteAuthorSubscription(req.params.authorId, req.user!.id, levelId);
    if (!('quote' in result)) return reply.status(result.status).send({ error: result.error });
    return { quote: result.quote };
  });

  app.post<{ Params: { authorId: string } }>('/api/blog/authors/:authorId/subscribe', async (req, reply) => {
    app.requireAuth(req);
    const { levelId, payment, reason } = subscriptionSchema.extend({
      payment: paymentSchema.optional(), reason: z.enum(cancellationReasons).optional(),
    }).parse(req.body);
    const { authorId } = req.params;
    const userId = req.user!.id;
    if (payment) {
      if (!levelId) return reply.status(400).send({ error: 'Выберите уровень.' });
      const result = await buyAuthorSubscription({ authorId, userId, levelId }, payment);
      if (!('paymentId' in result)) return reply.status(result.status).send({ error: result.error });
      return { subscribedLevelId: levelId, paymentId: result.paymentId, expiresAt: result.expiresAt };
    }
    const result = await changeAuthorAccess({ userId, authorId, levelId, reason });
    if ('error' in result) return reply.status(result.status).send({ error: result.error });
    const current = await prisma.authorSubscription.findFirst({ where: { userId, authorId, ...activeAuthors() } });
    return { subscribedLevelId: current?.levelId ?? null };
  });

  app.get<{ Params: { id: string } }>('/api/blog/:id', async (req, reply) => {
    const post = await prisma.blogPost.findFirst({
      where: { id: req.params.id, published: true },
      include: {
        ...deskInclude,
        comments: { orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 80, include: { files: commentFiles } },
      },
    });
    if (!post || (post.audience === 'self' && req.user?.id !== post.authorId)) {
      return reply.status(404).send({ error: 'Запись не найдена' });
    }
    const blocks = await viewerBlocks(req.user?.id ?? null);
    if (blocks.blogs.has(post.id) || blocks.people.has(post.authorId)) {
      return reply.status(404).send({ error: 'Запись не найдена' });
    }
    const geo = await countryBlocks(req);
    if (postBlocked(geo.index, geo.country, post.id)) return denyGeo(reply);
    const price = await accessPrice(req.user?.id, post.authorId);
    const moderator = Boolean(req.user && post.moderators?.some((row) => row.user.id === req.user!.id));
    const locked = !canSee(post, req.user?.id, price);
    const names = new Map(post.comments.map((comment) => [comment.id, comment.authorName || 'Читатель']));
    const [attachments, reactions] = await Promise.all([
      publicAttachments([post], geo, blocks.books),
      postReactions([post.id], req.user?.id),
    ]);
    return {
      post: card(post, {
        ...reactionSummary(reactions, post.id),
        locked,
        canComment: canWriteComment(post, req.user?.id, price, moderator || req.user?.id === post.authorId),
        canModerate: req.user?.id === post.authorId || moderator,
        attachment: attachments.get(post.id),
      }),
      comments: locked ? [] : post.comments.reverse().map((comment) => ({
        id: comment.id,
        authorName: comment.authorName || 'Читатель',
        body: comment.body,
        parentId: comment.parentId,
        parentAuthorName: comment.parentId ? names.get(comment.parentId) ?? '' : '',
        createdAt: comment.createdAt.toISOString(),
        mine: comment.userId === req.user?.id,
        attachments: comment.files,
      })),
    };
  });

  app.post<{ Params: { id: string } }>('/api/blog/:id/view', async (req, reply) => {
    const { guestId, source } = z.object({ guestId: z.string().uuid().optional(), source: trafficSource.default('unknown') }).parse(req.body ?? {});
    const userId = req.user?.id;
    const post = await prisma.blogPost.findFirst({
      where: { id: req.params.id, published: true },
      select: { id: true, authorId: true, audience: true },
    });
    if (!post || (post.audience === 'self' && post.authorId !== userId)) {
      return reply.status(404).send({ error: 'Запись не найдена' });
    }
    if (userId === post.authorId) return { ok: true };
    const blocks = await viewerBlocks(userId ?? null);
    if (blocks.blogs.has(post.id) || blocks.people.has(post.authorId)) {
      return reply.status(404).send({ error: 'Запись не найдена' });
    }
    await prisma.$transaction(async (tx) => {
      const updated = await tx.blogPost.updateMany({
        where: { id: post.id, published: true, audience: { not: 'self' } },
        data: { views: { increment: 1 } },
      });
      const readerKey = userId ? `u:${userId}` : guestId ? `g:${guestId}` : null;
      if (!updated.count) return;
      const day = new Date().toISOString().slice(0, 10);
      const traffic = { authorId: post.authorId, day, source };
      await tx.blogTrafficDay.upsert({
        where: { authorId_day_source: traffic }, create: { ...traffic, views: 1 }, update: { views: { increment: 1 } },
      });
      if (!readerKey) return;
      const subscription = userId && await tx.authorSubscription.findFirst({
        where: { userId, authorId: post.authorId, ...activeAuthors() }, select: { userId: true },
      });
      const subscriberViews = subscription ? 1 : 0;
      const otherViews = 1 - subscriberViews;
      await tx.blogPostReader.upsert({
        where: { postId_readerKey: { postId: post.id, readerKey } },
        create: { postId: post.id, readerKey, subscriberViews, otherViews },
        update: { subscriberViews: { increment: subscriberViews }, otherViews: { increment: otherViews } },
      });
    });
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/api/blog/:id/like', (req, reply) => changeReaction(app, req, reply));

  app.put<{ Params: { id: string } }>('/api/blog/:id/reaction', (req, reply) => {
    app.requireAuth(req);
    const { emoji } = z.object({ emoji: reactionEmoji.nullable() }).parse(req.body);
    return changeReaction(app, req, reply, emoji);
  });

  app.post<{ Params: { id: string } }>('/api/blog/:id/comments', { bodyLimit: maxCommentBase64 * maxCommentFiles + 32 * 1024 }, async (req, reply) => {
    app.requireAuth(req);
    const input = commentInput.parse(req.body);
    const post = await prisma.blogPost.findFirst({
      where: { id: req.params.id, published: true },
      include: {
        level: { select: { id: true, title: true, priceRub: true } },
        moderators: { include: { user: { select: { id: true, name: true } } } },
      },
    });
    if (!post || !await visibleToViewer(post, req.user!.id)) return reply.status(404).send({ error: 'Запись не найдена' });
    const price = await accessPrice(req.user!.id, post.authorId);
    const moderator = post.moderators.some((row) => row.user.id === req.user!.id);
    if (!canWriteComment(post, req.user!.id, price, moderator)) {
      return reply.status(403).send({ error: 'Комментарии к этой записи закрыты' });
    }
    const files: { name: string; size: number; data: Buffer; position: number }[] = [];
    for (const [position, { name, base64 }] of input.attachments.entries()) {
      if (base64.length > maxCommentBase64) {
        return reply.status(413).send({ error: 'Размер файла превышает 5 МБ' });
      }
      const data = Buffer.from(base64, 'base64');
      if (data.length > maxCommentFileSize) return reply.status(413).send({ error: 'Размер файла превышает 5 МБ' });
      if (data.toString('base64') !== base64) return reply.status(400).send({ error: 'Не удалось прочитать файл' });
      files.push({ name, size: data.length, data, position });
    }
    const parentId = input.parentId ?? '';
    const parent = parentId
      ? await prisma.blogComment.findFirst({
        where: { id: parentId, postId: post.id },
        select: { userId: true, authorName: true },
      })
      : null;
    if (parentId && !parent) return reply.status(400).send({ error: 'Комментарий для ответа не найден' });
    const me = await prisma.user.findUnique({ where: { id: req.user!.id }, select: { name: true } });
    const comment = await prisma.blogComment.create({
      data: {
        postId: post.id,
        userId: req.user!.id,
        authorName: me?.name?.trim() || 'Читатель',
        body: input.body,
        parentId,
        ...(files.length > 0 && { files: { create: files } }),
      },
      include: { files: commentFiles },
    });
    await writeNotices(commentNotices({
      target: 'blog',
      actorId: req.user!.id,
      actorName: comment.authorName,
      ownerId: post.authorId,
      parentUserId: parent?.userId ?? '',
      commentId: comment.id,
      subjectId: post.id,
      subjectTitle: post.title,
      body: comment.body || comment.files.map((file) => file.name).join(', '),
    }));
    return reply.status(201).send({
      comment: {
        id: comment.id,
        authorName: comment.authorName,
        body: comment.body,
        parentId: comment.parentId,
        parentAuthorName: parent?.authorName || '',
        createdAt: comment.createdAt.toISOString(),
        mine: true,
        attachments: comment.files,
      },
    });
  });

  app.get<{ Params: { id: string; commentId: string; fileId: string } }>('/api/blog/:id/comments/:commentId/attachments/:fileId', async (req, reply) => {
    const { id, commentId, fileId } = req.params;
    const post = await prisma.blogPost.findFirst({ where: { id, published: true }, include: { level: true } });
    const userId = req.user?.id;
    if (!post || !await visibleToViewer(post, userId) || !canSee(post, userId, await accessPrice(userId, post.authorId))) {
      return reply.status(404).send({ error: 'Файл не найден' });
    }
    const file = await prisma.blogCommentFile.findFirst({ where: { id: fileId, commentId, comment: { postId: id } } });
    if (!file) return reply.status(404).send({ error: 'Файл не найден' });
    const encodedName = encodeURIComponent(file.name).replace(/['()*]/g, (char) => '%' + char.charCodeAt(0).toString(16));
    return reply
      .type('application/octet-stream')
      .header('Content-Disposition', "attachment; filename*=UTF-8''" + encodedName)
      .header('X-Content-Type-Options', 'nosniff')
      .header('Cache-Control', 'private, no-store')
      .send(Buffer.from(file.data));
  });

  app.delete<{ Params: { id: string; commentId: string } }>('/api/blog/:id/comments/:commentId', async (req, reply) => {
    app.requireAuth(req);
    const comment = await prisma.blogComment.findFirst({
      where: { id: req.params.commentId, postId: req.params.id },
      select: { id: true, userId: true, post: { select: { authorId: true, moderators: { select: { userId: true } } } } },
    });
    if (!comment) return reply.status(404).send({ error: 'Комментарий не найден' });
    const moderator = comment.post.moderators.some((row) => row.userId === req.user!.id);
    if (comment.userId !== req.user!.id && comment.post.authorId !== req.user!.id && !moderator) {
      return reply.status(403).send({ error: 'Удалить комментарий может автор, модератор или тот, кто его написал' });
    }
    await prisma.blogComment.delete({ where: { id: comment.id } });
    return reply.status(204).send();
  });

  app.post<{ Params: { id: string } }>('/api/blog/:id/report', async (req, reply) => {
    app.requireAuth(req);
    const input = z.object({ note: z.string().trim().min(1).max(1000), kind: feedbackKind.default('complaint') }).parse(req.body);
    const post = await prisma.blogPost.findFirst({
      where: { id: req.params.id, published: true },
      select: { id: true, authorId: true, title: true, audience: true },
    });
    if (!post || !await visibleToViewer(post, req.user!.id)) return reply.status(404).send({ error: 'Запись не найдена' });
    const report = await prisma.blogReport.create({
      data: { postId: post.id, postTitle: post.title, userId: req.user!.id, ...input },
    });
    if (input.kind === 'complaint') await writeNotices(blogReportNotice({
      authorId: post.authorId,
      actorId: req.user!.id,
      postId: post.id,
      postTitle: post.title,
      reportId: report.id,
      note: input.note,
    }));
    return reply.status(201).send({ ok: true });
  });

  app.get('/api/admin/blog-feedback', async (req, reply) => {
    if (!(await requireAdmin(app, req, reply))) return;
    const { kind, status, page } = z.object({
      kind: feedbackKind.optional(),
      status: feedbackStatus.optional(),
      page: z.coerce.number().int().min(1).max(100_000).default(1),
    }).parse(req.query);
    const pageSize = 30;
    const reports = await prisma.blogReport.findMany({
      where: { kind, status },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: (page - 1) * pageSize,
      take: pageSize + 1,
      include: { user: { select: { name: true } }, post: { select: { published: true, audience: true } } },
    });
    return { reports: reports.slice(0, pageSize), hasNext: reports.length > pageSize };
  });

  app.patch<{ Params: { id: string } }>('/api/admin/blog-feedback/:id', async (req, reply) => {
    if (!(await requireAdmin(app, req, reply))) return;
    const { status } = z.object({ status: feedbackStatus }).parse(req.body);
    const { count } = await prisma.blogReport.updateMany({ where: { id: req.params.id }, data: { status } });
    if (!count) return reply.status(404).send({ error: 'Обращение не найдено' });
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/api/blog/:id/donate', async (req, reply) => {
    app.requireAuth(req);
    const senderId = req.user!.id;
    const input = z.object({
      requestId: z.string().uuid(),
      amountCents: z.number().int().min(100).max(10_000_000),
      note: z.string().trim().max(200).default(''),
    }).parse(req.body);
    let result = await previousBlogDonation(senderId, req.params.id, input);
    if (!result) {
      const post = await prisma.blogPost.findFirst({
        where: { id: req.params.id, published: true, audience: { not: 'self' } },
        select: { id: true, authorId: true },
      });
      const blocks = await viewerBlocks(senderId);
      if (!post || blocks.blogs.has(post.id) || blocks.people.has(post.authorId)) {
        return reply.status(404).send({ error: 'Запись не найдена' });
      }
      result = await transferBlogDonation(senderId, post.authorId, post.id, input);
    }
    if (!result.receipt) return reply.status(result.status).send({ error: result.error });
    const donation = result.receipt;
    await writeNotices(donationNotice({
      authorId: donation.authorId,
      actorId: senderId,
      actorName: req.user!.name || 'Читатель',
      amountCents: donation.amountCents,
      postId: donation.postId,
      postTitle: donation.postTitle,
      donationId: donation.id,
      note: input.note,
    }));
    return reply.status(201).send({ donationId: donation.id, amountCents: donation.amountCents });
  });

  app.get('/api/me/blog/people', async (req) => {
    app.requireAuth(req);
    const q = z.object({ q: z.string().trim().max(80).optional() }).parse(req.query).q ?? '';
    if (q.length < 2) return { people: [] };
    const people = await prisma.user.findMany({
      where: {
        id: { not: req.user!.id },
        name: { contains: q, mode: 'insensitive' },
      },
      select: { id: true, name: true },
      take: 8,
      orderBy: { name: 'asc' },
    });
    return { people: people.map((person) => ({ id: person.id, name: person.name?.trim() || 'Без имени' })) };
  });

  app.get('/api/me/blog/attachments', async (req) => {
    app.requireAuth(req);
    return { options: await attachmentOptions(req.user!.id) };
  });

  app.get('/api/me/blog', async (req, reply) => {
    app.requireAuth(req);
    reply.header('Cache-Control', 'private, no-store');
    const [posts, levels, likes, profile, stats] = await Promise.all([
      prisma.blogPost.findMany({
        where: { authorId: req.user!.id },
        include: deskInclude,
        orderBy: { updatedAt: 'desc' },
      }),
      prisma.authorLevel.findMany({
        where: { authorId: req.user!.id },
        orderBy: { priceRub: 'asc' },
        include: { _count: { select: { posts: true, subscriptions: { where: activeAuthors() } } } },
      }),
      prisma.blogLike.findMany({ where: { userId: req.user!.id }, select: { postId: true } }),
      prisma.blogProfile.findUnique({ where: { authorId: req.user!.id }, select: blogProfileSelect }),
      blogStats(req.user!.id),
    ]);
    const liked = new Set(likes.map((row) => row.postId));
    return {
      posts: posts.map((post) => card(post, { liked: liked.has(post.id), own: true })),
      stats,
      profile: profile ? { ...profile, nickname: profile.nickname ?? '' } : null,
      levels: levels.map((level) => ({
        id: level.id,
        title: level.title,
        description: level.description,
        priceRub: level.priceRub,
        avatar: level.avatar,
        available: level.available,
        postCount: level._count.posts,
        subscriberCount: level._count.subscriptions,
      })),
    };
  });

  app.get<{ Params: { id: string } }>('/api/me/blog/:id/stats', async (req, reply) => {
    app.requireAuth(req);
    reply.header('Cache-Control', 'private, no-store');
    const stats = await singlePostStats(req.user!.id, req.params.id);
    if (!stats) return reply.status(404).send({ error: 'Запись не найдена' });
    return { stats };
  });

  app.get('/api/me/blog/earnings', async (req, reply) => {
    app.requireAuth(req);
    reply.header('Cache-Control', 'private, no-store');
    const { days } = z.object({ days: earningsPeriod }).parse(req.query);
    return blogEarnings(req.user!.id, days);
  });

  app.get<{ Params: { area: string } }>('/api/me/blog/earnings/list/:area', async (req, reply) => {
    app.requireAuth(req);
    reply.header('Cache-Control', 'private, no-store');
    const { area } = z.object({ area: z.enum(['subscribers', 'donations', 'events']) }).parse(req.params);
    const filter = earningsListQuery.parse(req.query);
    return area === 'subscribers'
      ? earningsSubscribers(req.user!.id, filter)
      : earningsActivities(req.user!.id, filter, area);
  });

  app.get('/api/me/blog/earnings/export', async (req, reply) => {
    app.requireAuth(req);
    reply.header('Cache-Control', 'private, no-store');
    reply.header('Content-Disposition', 'attachment; filename="openwritter-earnings.xlsx"');
    return reply.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .send(await exportBlogEarnings(req.user!.id));
  });

  app.put('/api/me/blog/profile', async (req, reply) => {
    app.requireAuth(req);
    const input = blogProfileSchema.parse(req.body);
    const authorId = req.user!.id;
    const data = { ...input, nickname: input.nickname || null };
    try {
      const profile = await prisma.blogProfile.upsert({
        where: { authorId },
        create: { authorId, ...data },
        update: data,
        select: blogProfileSelect,
      });
      return { profile: { ...profile, nickname: profile.nickname ?? '' } };
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        return reply.status(409).send({ error: 'Этот ник уже занят' });
      }
      throw err;
    }
  });

  app.get('/api/me/blog/memberships', async (req, reply) => {
    app.requireAuth(req);
    reply.header('Cache-Control', 'private, no-store');
    const rows = await prisma.authorSubscription.findMany({
      where: { userId: req.user!.id, ...activeAuthors() },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: {
        authorId: true, expiresAt: true, cancelledAt: true, createdAt: true,
        author: { select: { name: true } }, level: { select: { title: true } },
      },
    });
    return { memberships: rows.map((row) => ({
      authorId: row.authorId,
      authorName: row.author.name?.trim() || 'Автор',
      levelTitle: row.level.title,
      subscribedAt: row.createdAt,
      expiresAt: row.expiresAt,
      cancelled: Boolean(row.cancelledAt),
    })) };
  });

  app.get('/api/me/blog/subscriptions', async (req) => {
    app.requireAuth(req);
    const { q } = z.object({ q: z.string().trim().max(80).optional() }).parse(req.query);
    const rows = await prisma.authorSubscription.findMany({
      where: {
        authorId: req.user!.id,
        ...activeAuthors(),
        ...(q ? { user: { name: { contains: q, mode: 'insensitive' } } } : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 50,
      select: { createdAt: true, levelId: true, user: { select: { id: true, name: true } } },
    });
    return { readers: rows.map((row) => ({
      id: row.user.id,
      name: row.user.name?.trim() || 'Читатель',
      levelId: row.levelId,
      createdAt: row.createdAt.toISOString(),
    })) };
  });

  app.put<{ Params: { readerId: string } }>('/api/me/blog/subscriptions/:readerId', async (req, reply) => {
    app.requireAuth(req);
    const { levelId } = subscriptionSchema.parse(req.body);
    const authorId = req.user!.id;
    const userId = req.params.readerId;
    const result = await changeAuthorAccess({ authorId, userId, levelId, managed: true });
    if ('error' in result) return reply.status(result.status).send({ error: result.error });
    return { levelId };
  });

  app.post('/api/me/blog', async (req, reply) => {
    app.requireAuth(req);
    const input = writeSchema.parse(req.body);
    if (input.attachment && !(await canAttach(req.user!.id, input.attachment))) {
      return reply.status(400).send({ error: 'Выберите свою опубликованную книгу или цикл' });
    }
    const defaults = input.audience === undefined || input.commentAccess === undefined
      ? await prisma.blogProfile.findUnique({
        where: { authorId: req.user!.id },
        select: { defaultAudience: true, defaultCommentAccess: true },
      })
      : null;
    const audience = input.audience ?? (input.levelId ? 'level' : defaults?.defaultAudience ?? 'all');
    const levelId = audience === 'level' ? input.levelId ?? null : null;
    if (audience === 'level' && !levelId) return reply.status(400).send({ error: 'Выберите уровень подписки' });
    if (levelId) {
      const level = await prisma.authorLevel.findFirst({ where: { id: levelId, authorId: req.user!.id }, select: { id: true } });
      if (!level) return reply.status(400).send({ error: 'Такого уровня нет' });
    }
    const mods = await moderatorIdsOf(req.user!.id, input.moderatorIds ?? []);
    const post = await prisma.blogPost.create({
      data: {
        authorId: req.user!.id,
        title: input.title,
        body: cleanHtml(input.body),
        topic: input.topic ?? '',
        tags: input.tags ?? [],
        attachment: input.attachment ?? Prisma.DbNull,
        published: input.published ?? false,
        publishedAt: input.published ? new Date() : null,
        levelId,
        audience,
        commentAccess: input.commentAccess ?? defaults?.defaultCommentAccess ?? 'all',
        moderators: { create: mods.map((userId) => ({ userId })) },
      },
      include: deskInclude,
    });
    if (post.published) await notifyBlogReaders(req.user!.id, req.user!.name?.trim() || 'Автор', post);
    return reply.status(201).send({ post: card(post, { own: true }) });
  });

  app.patch<{ Params: { id: string } }>('/api/me/blog/:id', async (req, reply) => {
    app.requireAuth(req);
    const input = writeSchema.partial().refine((row) => Object.keys(row).length > 0, 'Нечего сохранять').parse(req.body);
    const existing = await prisma.blogPost.findFirst({
      where: { id: req.params.id, authorId: req.user!.id },
      select: { id: true, published: true, publishedAt: true, audience: true, levelId: true },
    });
    if (!existing) return reply.status(404).send({ error: 'Запись не найдена' });
    if (input.attachment && !(await canAttach(req.user!.id, input.attachment))) {
      return reply.status(400).send({ error: 'Выберите свою опубликованную книгу или цикл' });
    }
    const pickedLevel = input.audience === undefined && input.levelId !== undefined;
    const audience = pickedLevel ? (input.levelId ? 'level' : 'all') : (input.audience ?? existing.audience);
    const levelId = audience === 'level' ? (input.levelId === undefined ? existing.levelId : input.levelId) : null;
    if (audience === 'level' && !levelId) return reply.status(400).send({ error: 'Выберите уровень подписки' });
    if (levelId) {
      const level = await prisma.authorLevel.findFirst({ where: { id: levelId, authorId: req.user!.id }, select: { id: true } });
      if (!level) return reply.status(400).send({ error: 'Такого уровня нет' });
    }
    const mods = input.moderatorIds === undefined ? null : await moderatorIdsOf(req.user!.id, input.moderatorIds);
    const post = await prisma.$transaction(async (tx) => {
      if (input.published && !existing.publishedAt) {
        await tx.blogPost.updateMany({
          where: { id: existing.id, publishedAt: null },
          data: { publishedAt: new Date() },
        });
      }
      return tx.blogPost.update({
        where: { id: existing.id },
        data: {
          ...(input.title !== undefined && { title: input.title }),
          ...(input.body !== undefined && { body: cleanHtml(input.body) }),
          ...(input.topic !== undefined && { topic: input.topic }),
          ...(input.tags !== undefined && { tags: input.tags }),
          ...(input.attachment !== undefined && { attachment: input.attachment ?? Prisma.DbNull }),
          ...(input.published !== undefined && { published: input.published }),
          ...(input.audience !== undefined || input.levelId !== undefined ? { audience, levelId } : {}),
          ...(input.commentAccess !== undefined && { commentAccess: input.commentAccess }),
          ...(mods && {
            moderators: {
              deleteMany: {},
              create: mods.map((userId) => ({ userId })),
            },
          }),
        },
        include: deskInclude,
      });
    });
    if (post.published && !existing.published) {
      await notifyBlogReaders(req.user!.id, req.user!.name?.trim() || 'Автор', post);
    }
    return { post: card(post, { own: true }) };
  });

  app.delete<{ Params: { id: string } }>('/api/me/blog/:id', async (req, reply) => {
    app.requireAuth(req);
    const removed = await prisma.blogPost.deleteMany({ where: { id: req.params.id, authorId: req.user!.id } });
    if (removed.count === 0) return reply.status(404).send({ error: 'Запись не найдена' });
    return reply.status(204).send();
  });

  app.post('/api/me/blog/levels', async (req, reply) => {
    app.requireAuth(req);
    const input = levelSchema.parse(req.body);
    if (!avatarOk(input.avatar)) return reply.status(400).send({ error: 'Аватар уровня: картинка до 100 КБ' });
    const level = await prisma.authorLevel.create({
      data: {
        authorId: req.user!.id,
        title: input.title,
        description: input.description ?? '',
        priceRub: input.priceRub,
        avatar: input.avatar ?? '',
        available: input.available ?? true,
      },
    });
    return reply.status(201).send({ level });
  });

  app.patch<{ Params: { id: string } }>('/api/me/blog/levels/:id', async (req, reply) => {
    app.requireAuth(req);
    const input = levelSchema.partial().parse(req.body);
    if (!avatarOk(input.avatar)) return reply.status(400).send({ error: 'Аватар уровня: картинка до 100 КБ' });
    const authorId = req.user!.id;
    const { id } = req.params;
    const result = await prisma.$transaction(async (tx) => {
      const current = await lockLevel(tx, authorId, id);
      if (!current) return { status: 404, error: 'Уровень не найден' };
      if (input.priceRub !== undefined && input.priceRub !== current.priceRub &&
          await tx.authorSubscription.count({ where: { levelId: id, ...activeAuthors() } }) > 0) {
        return { status: 409, error: 'У этого уровня есть подписчики. Для новой цены создайте отдельный уровень.' };
      }
      return { status: 200, level: await tx.authorLevel.update({ where: { id }, data: input }) };
    });
    if (result.status !== 200) return reply.status(result.status).send({ error: result.error });
    return { level: result.level };
  });

  app.delete<{ Params: { id: string } }>('/api/me/blog/levels/:id', async (req, reply) => {
    app.requireAuth(req);
    const { id } = req.params;
    const status = await prisma.$transaction(async (tx) => {
      if (!(await lockLevel(tx, req.user!.id, id))) return 404;
      const [posts, readers] = await Promise.all([
        tx.blogPost.count({ where: { levelId: id } }),
        tx.authorSubscription.count({ where: { levelId: id, ...activeAuthors() } }),
      ]);
      if (posts || readers) return 409;
      await tx.authorLevel.delete({ where: { id } });
      return 204;
    });
    if (status === 404) return reply.status(404).send({ error: 'Уровень не найден' });
    if (status === 409) return reply.status(409).send({ error: 'Уровень связан с публикациями или подписчиками. Можно закрыть приём новых подписчиков.' });
    return reply.status(204).send();
  });
};

async function notifyBlogReaders(authorId: string, authorName: string, post: { id: string; title: string }) {
  const [follows, subs] = await Promise.all([
    prisma.authorFollow.findMany({ where: { authorId }, select: { userId: true } }),
    prisma.authorSubscription.findMany({ where: { authorId, ...activeAuthors() }, select: { userId: true } }),
  ]);
  await writeNotices(blogPostNotices({
    authorId,
    authorName,
    postId: post.id,
    title: post.title,
    audienceIds: [...follows.map((row) => row.userId), ...subs.map((row) => row.userId)],
  }));
}
