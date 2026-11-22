import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import { prisma } from '../lib/prisma.js';

const tagsSchema = z.array(z.string().trim().min(1).max(24)).max(8);
const writeSchema = z.object({
  title: z.string().trim().min(1).max(160),
  body: z.string().trim().min(1).max(40_000),
  topic: z.string().trim().max(80).optional(),
  tags: tagsSchema.optional(),
  published: z.boolean().optional(),
  levelId: z.string().trim().max(40).nullable().optional(),
});
const levelSchema = z.object({
  title: z.string().trim().min(1).max(80),
  description: z.string().trim().max(500).optional(),
  priceRub: z.number().int().min(1).max(100_000),
  avatar: z.string().max(120_000).optional(),
});

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
  return input
    .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?>[\s\S]*?<\/style>/gi, '')
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/javascript:/gi, '');
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
  views: number;
  published: boolean;
  levelId: string | null;
  createdAt: Date;
  updatedAt: Date;
  author?: { name: string | null } | null;
  level?: { id: string; title: string; priceRub: number } | null;
  _count?: { comments: number; likes: number; donations: number };
};

function card(post: PostRow, extra: { liked?: boolean; locked?: boolean; chars?: number } = {}) {
  const text = plainText(post.body);
  const locked = extra.locked === true;
  return {
    id: post.id,
    authorId: post.authorId,
    authorName: post.author?.name?.trim() || 'Автор',
    title: post.title,
    body: locked ? '' : asHtml(post.body),
    excerpt: text.slice(0, 280),
    topic: post.topic,
    tags: post.tags,
    views: post.views,
    chars: extra.chars ?? text.length,
    comments: post._count?.comments ?? 0,
    likes: post._count?.likes ?? 0,
    donations: post._count?.donations ?? 0,
    liked: extra.liked ?? false,
    published: post.published,
    locked,
    levelId: post.levelId,
    levelTitle: post.level?.title ?? '',
    levelPriceRub: post.level?.priceRub ?? 0,
    createdAt: post.createdAt.toISOString(),
    updatedAt: post.updatedAt.toISOString(),
  };
}

const postInclude = {
  author: { select: { name: true } },
  level: { select: { id: true, title: true, priceRub: true } },
  _count: { select: { comments: true, likes: true, donations: true } },
} as const;

async function accessPrice(userId: string | undefined, authorId: string): Promise<number> {
  if (!userId) return 0;
  const sub = await prisma.authorSubscription.findUnique({
    where: { userId_authorId: { userId, authorId } },
    include: { level: { select: { priceRub: true } } },
  });
  return sub?.level.priceRub ?? 0;
}

export const blogRoutes: FastifyPluginAsync = async (app) => {
  app.get('/api/blog', async (req) => {
    const posts = await prisma.blogPost.findMany({
      where: { published: true },
      include: postInclude,
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    const liked = new Set<string>();
    if (req.user?.id && posts.length) {
      const rows = await prisma.blogLike.findMany({
        where: { userId: req.user.id, postId: { in: posts.map((post) => post.id) } },
        select: { postId: true },
      });
      for (const row of rows) liked.add(row.postId);
    }
    return { posts: posts.map((post) => card(post, { liked: liked.has(post.id), locked: false })) };
  });

  app.get<{ Params: { authorId: string } }>('/api/blog/authors/:authorId', async (req) => {
    const author = await prisma.user.findUnique({
      where: { id: req.params.authorId },
      select: { id: true, name: true },
    });
    if (!author) return { author: null, levels: [], following: false, subscribedLevelId: null, followers: 0 };
    const [levels, followers, follow, sub] = await Promise.all([
      prisma.authorLevel.findMany({ where: { authorId: author.id }, orderBy: { priceRub: 'asc' } }),
      prisma.authorFollow.count({ where: { authorId: author.id } }),
      req.user ? prisma.authorFollow.findUnique({ where: { userId_authorId: { userId: req.user.id, authorId: author.id } } }) : null,
      req.user ? prisma.authorSubscription.findUnique({ where: { userId_authorId: { userId: req.user.id, authorId: author.id } } }) : null,
    ]);
    return {
      author: { id: author.id, name: author.name?.trim() || 'Автор' },
      followers,
      following: Boolean(follow),
      subscribedLevelId: sub?.levelId ?? null,
      levels: levels.map((level) => ({
        id: level.id,
        title: level.title,
        description: level.description,
        priceRub: level.priceRub,
        avatar: level.avatar,
      })),
    };
  });

  app.post<{ Params: { authorId: string } }>('/api/blog/authors/:authorId/follow', async (req) => {
    app.requireAuth(req);
    if (req.params.authorId === req.user!.id) return { following: false };
    const key = { userId: req.user!.id, authorId: req.params.authorId };
    const existing = await prisma.authorFollow.findUnique({ where: { userId_authorId: key } });
    if (existing) {
      await prisma.authorFollow.delete({ where: { userId_authorId: key } });
      return { following: false };
    }
    await prisma.authorFollow.create({ data: key });
    return { following: true };
  });

  app.post<{ Params: { authorId: string } }>('/api/blog/authors/:authorId/subscribe', async (req, reply) => {
    app.requireAuth(req);
    const input = z.object({ levelId: z.string().min(1).nullable() }).parse(req.body);
    if (req.params.authorId === req.user!.id) return reply.status(400).send({ error: 'На себя подписаться нельзя' });
    if (!input.levelId) {
      await prisma.authorSubscription.deleteMany({ where: { userId: req.user!.id, authorId: req.params.authorId } });
      return { subscribedLevelId: null };
    }
    const level = await prisma.authorLevel.findFirst({ where: { id: input.levelId, authorId: req.params.authorId } });
    if (!level) return reply.status(404).send({ error: 'Уровень не найден' });
    await prisma.authorSubscription.upsert({
      where: { userId_authorId: { userId: req.user!.id, authorId: req.params.authorId } },
      create: { userId: req.user!.id, authorId: req.params.authorId, levelId: level.id },
      update: { levelId: level.id },
    });
    return { subscribedLevelId: level.id };
  });

  app.get<{ Params: { id: string } }>('/api/blog/:id', async (req, reply) => {
    const post = await prisma.blogPost.findFirst({
      where: { id: req.params.id, published: true },
      include: {
        ...postInclude,
        comments: { orderBy: { createdAt: 'asc' }, take: 80 },
      },
    });
    if (!post) return reply.status(404).send({ error: 'Запись не найдена' });
    const price = await accessPrice(req.user?.id, post.authorId);
    const locked = Boolean(post.level && req.user?.id !== post.authorId && price < post.level.priceRub);
    const liked = req.user
      ? Boolean(await prisma.blogLike.findUnique({ where: { userId_postId: { userId: req.user.id, postId: post.id } } }))
      : false;
    return {
      post: card(post, { liked, locked }),
      comments: locked ? [] : post.comments.map((comment) => ({
        id: comment.id,
        authorName: comment.authorName || 'Читатель',
        body: comment.body,
        createdAt: comment.createdAt.toISOString(),
        mine: comment.userId === req.user?.id,
      })),
    };
  });

  app.post<{ Params: { id: string } }>('/api/blog/:id/view', async (req, reply) => {
    const updated = await prisma.blogPost.updateMany({
      where: { id: req.params.id, published: true },
      data: { views: { increment: 1 } },
    });
    if (updated.count === 0) return reply.status(404).send({ error: 'Запись не найдена' });
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/api/blog/:id/like', async (req, reply) => {
    app.requireAuth(req);
    const post = await prisma.blogPost.findFirst({ where: { id: req.params.id, published: true }, select: { id: true } });
    if (!post) return reply.status(404).send({ error: 'Запись не найдена' });
    const key = { userId: req.user!.id, postId: post.id };
    const existing = await prisma.blogLike.findUnique({ where: { userId_postId: key } });
    if (existing) await prisma.blogLike.delete({ where: { userId_postId: key } });
    else await prisma.blogLike.create({ data: key });
    const likes = await prisma.blogLike.count({ where: { postId: post.id } });
    return { liked: !existing, likes };
  });

  app.post<{ Params: { id: string } }>('/api/blog/:id/comments', async (req, reply) => {
    app.requireAuth(req);
    const input = z.object({ body: z.string().trim().min(1).max(2000) }).parse(req.body);
    const post = await prisma.blogPost.findFirst({ where: { id: req.params.id, published: true }, select: { id: true } });
    if (!post) return reply.status(404).send({ error: 'Запись не найдена' });
    const me = await prisma.user.findUnique({ where: { id: req.user!.id }, select: { name: true } });
    const comment = await prisma.blogComment.create({
      data: { postId: post.id, userId: req.user!.id, authorName: me?.name?.trim() || 'Читатель', body: input.body },
    });
    return reply.status(201).send({
      comment: { id: comment.id, authorName: comment.authorName, body: comment.body, createdAt: comment.createdAt.toISOString(), mine: true },
    });
  });

  app.post<{ Params: { id: string } }>('/api/blog/:id/report', async (req, reply) => {
    app.requireAuth(req);
    const input = z.object({ note: z.string().trim().min(1).max(1000) }).parse(req.body);
    const post = await prisma.blogPost.findFirst({ where: { id: req.params.id, published: true }, select: { id: true } });
    if (!post) return reply.status(404).send({ error: 'Запись не найдена' });
    await prisma.blogReport.create({ data: { postId: post.id, userId: req.user!.id, note: input.note } });
    return reply.status(201).send({ ok: true });
  });

  app.post<{ Params: { id: string } }>('/api/blog/:id/donate', async (req, reply) => {
    app.requireAuth(req);
    const input = z.object({
      amountRub: z.number().int().min(1).max(100_000),
      note: z.string().trim().max(200).optional(),
    }).parse(req.body);
    const post = await prisma.blogPost.findFirst({ where: { id: req.params.id, published: true }, select: { id: true } });
    if (!post) return reply.status(404).send({ error: 'Запись не найдена' });
    await prisma.blogDonation.create({
      data: { postId: post.id, userId: req.user!.id, amountRub: input.amountRub, note: input.note ?? '' },
    });
    const donations = await prisma.blogDonation.count({ where: { postId: post.id } });
    return reply.status(201).send({ donations });
  });

  app.get('/api/me/blog', async (req) => {
    app.requireAuth(req);
    const [posts, levels, likes] = await Promise.all([
      prisma.blogPost.findMany({
        where: { authorId: req.user!.id },
        include: postInclude,
        orderBy: { updatedAt: 'desc' },
      }),
      prisma.authorLevel.findMany({ where: { authorId: req.user!.id }, orderBy: { priceRub: 'asc' } }),
      prisma.blogLike.findMany({ where: { userId: req.user!.id }, select: { postId: true } }),
    ]);
    const liked = new Set(likes.map((row) => row.postId));
    return {
      posts: posts.map((post) => card(post, { liked: liked.has(post.id) })),
      levels: levels.map((level) => ({
        id: level.id,
        title: level.title,
        description: level.description,
        priceRub: level.priceRub,
        avatar: level.avatar,
      })),
    };
  });

  app.post('/api/me/blog', async (req, reply) => {
    app.requireAuth(req);
    const input = writeSchema.parse(req.body);
    if (input.levelId) {
      const level = await prisma.authorLevel.findFirst({ where: { id: input.levelId, authorId: req.user!.id }, select: { id: true } });
      if (!level) return reply.status(400).send({ error: 'Такого уровня нет' });
    }
    const post = await prisma.blogPost.create({
      data: {
        authorId: req.user!.id,
        title: input.title,
        body: cleanHtml(input.body),
        topic: input.topic ?? '',
        tags: input.tags ?? [],
        published: input.published ?? false,
        levelId: input.levelId ?? null,
      },
      include: postInclude,
    });
    return reply.status(201).send({ post: card(post) });
  });

  app.patch<{ Params: { id: string } }>('/api/me/blog/:id', async (req, reply) => {
    app.requireAuth(req);
    const input = writeSchema.partial().refine((row) => Object.keys(row).length > 0, 'Нечего сохранять').parse(req.body);
    const existing = await prisma.blogPost.findFirst({ where: { id: req.params.id, authorId: req.user!.id }, select: { id: true } });
    if (!existing) return reply.status(404).send({ error: 'Запись не найдена' });
    if (input.levelId) {
      const level = await prisma.authorLevel.findFirst({ where: { id: input.levelId, authorId: req.user!.id }, select: { id: true } });
      if (!level) return reply.status(400).send({ error: 'Такого уровня нет' });
    }
    const post = await prisma.blogPost.update({
      where: { id: existing.id },
      data: {
        ...(input.title !== undefined && { title: input.title }),
        ...(input.body !== undefined && { body: cleanHtml(input.body) }),
        ...(input.topic !== undefined && { topic: input.topic }),
        ...(input.tags !== undefined && { tags: input.tags }),
        ...(input.published !== undefined && { published: input.published }),
        ...(input.levelId !== undefined && { levelId: input.levelId }),
      },
      include: postInclude,
    });
    return { post: card(post) };
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
      },
    });
    return reply.status(201).send({ level });
  });

  app.patch<{ Params: { id: string } }>('/api/me/blog/levels/:id', async (req, reply) => {
    app.requireAuth(req);
    const input = levelSchema.partial().parse(req.body);
    if (!avatarOk(input.avatar)) return reply.status(400).send({ error: 'Аватар уровня: картинка до 100 КБ' });
    const existing = await prisma.authorLevel.findFirst({ where: { id: req.params.id, authorId: req.user!.id }, select: { id: true } });
    if (!existing) return reply.status(404).send({ error: 'Уровень не найден' });
    const level = await prisma.authorLevel.update({ where: { id: existing.id }, data: input });
    return { level };
  });

  app.delete<{ Params: { id: string } }>('/api/me/blog/levels/:id', async (req, reply) => {
    app.requireAuth(req);
    const removed = await prisma.authorLevel.deleteMany({ where: { id: req.params.id, authorId: req.user!.id } });
    if (removed.count === 0) return reply.status(404).send({ error: 'Уровень не найден' });
    return reply.status(204).send();
  });
};
