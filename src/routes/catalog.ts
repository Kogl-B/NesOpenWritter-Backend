import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import { prisma } from '../lib/prisma.js';
import { GENRES, expandGenre, genreName } from '../lib/genres.js';
import { readerReportCreateSchema } from '../lib/schemas.js';

interface RawBook {
  id: string;
  name: string;
  description: string | null;
  settings: unknown;
  ownerId: string;
  authorName: string | null;
  createdAt: Date;
  updatedAt: Date;
  words: number;
  chapters: number;
  textUpdatedAt: Date | null;
}

export interface BookCard {
  id: string;
  title: string;
  description: string;
  authorId: string;
  authorName: string;
  genres: string[];
  genreNames: string[];
  tags: string[];
  status: 'writing' | 'complete' | 'frozen';
  cycle: string;
  authorNote: string;
  createdAt: string;
  updatedAt: string;
  textUpdatedAt: string;
  words: number;
  chapters: number;
  views: number;
  likes: number;
  favorites: number;
  readingNow: number;
  liked: boolean;
  disliked: boolean;
  favorite: boolean;
  reading: boolean;
  shelf: '' | 'reading' | 'later' | 'done' | 'skip';
  cover: string;
  structure: 'chapters' | 'chapters-scenes';
}

function metaOf(settings: unknown) {
  const root = settings && typeof settings === 'object' ? (settings as Record<string, unknown>) : {};
  const catalog = root.catalog && typeof root.catalog === 'object' ? (root.catalog as Record<string, unknown>) : {};
  const genres = Array.isArray(catalog.genres) ? catalog.genres.filter((x): x is string => typeof x === 'string') : [];
  const tags = Array.isArray(catalog.tags) ? catalog.tags.filter((x): x is string => typeof x === 'string') : [];
  const status = catalog.status === 'complete' || catalog.status === 'frozen' ? catalog.status : 'writing';
  return {
    genres,
    tags,
    status: status as BookCard['status'],
    cycle: typeof catalog.cycle === 'string' ? catalog.cycle : '',
    authorNote: typeof catalog.authorNote === 'string' ? catalog.authorNote : '',
    cover: typeof root.cover === 'string' && root.cover.startsWith('data:image/') && root.cover.length <= 220_000 ? root.cover : '',
    structure: root.structure === 'chapters' ? 'chapters' as const : 'chapters-scenes' as const,
  };
}

async function blockedAuthors(userId: string | null): Promise<Set<string>> {
  if (!userId) return new Set();
  const me = await prisma.user.findUnique({ where: { id: userId }, select: { settings: true } });
  const raw = me?.settings && typeof me.settings === 'object' ? (me.settings as { blockedAuthorIds?: unknown }).blockedAuthorIds : [];
  if (!Array.isArray(raw)) return new Set();
  return new Set(raw.filter((id): id is string => typeof id === 'string' && id !== userId));
}

async function loadBooks(userId: string | null): Promise<BookCard[]> {
  const rows = await prisma.$queryRaw<RawBook[]>`
    SELECT p.id, p.name, p.description, p.settings, p."ownerId",
           u.name AS "authorName", p."createdAt", p."updatedAt",
           COALESCE(SUM(c."wordCount"), 0)::int AS words,
           COUNT(c.id)::int AS chapters,
           MAX(c."updatedAt") AS "textUpdatedAt"
    FROM projects p
    JOIN users u ON u.id = p."ownerId"
    LEFT JOIN chapters c ON c."projectId" = p.id
    WHERE COALESCE(p.settings #>> '{catalog,published}', '') = 'true'
    GROUP BY p.id, u.name
  `;
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const [views, mine] = await Promise.all([
    prisma.bookView.groupBy({ by: ['projectId'], where: { projectId: { in: ids } }, _count: { _all: true } }),
    userId
      ? prisma.bookReaction.findMany({ where: { userId, projectId: { in: ids } } })
      : Promise.resolve([]),
  ]);
  const likeRows = await prisma.bookReaction.findMany({
    where: { projectId: { in: ids }, OR: [{ liked: true }, { favorite: true }, { lastReadAt: { not: null } }] },
    select: { projectId: true, liked: true, favorite: true, lastReadAt: true },
  });
  const viewOf = new Map(views.map((v) => [v.projectId, v._count._all]));
  const likeOf = new Map<string, number>();
  const favOf = new Map<string, number>();
  const readOf = new Map<string, number>();
  const cutoff = Date.now() - 14 * 86400000;
  for (const row of likeRows) {
    if (row.liked) likeOf.set(row.projectId, (likeOf.get(row.projectId) ?? 0) + 1);
    if (row.favorite) favOf.set(row.projectId, (favOf.get(row.projectId) ?? 0) + 1);
    if (row.lastReadAt && row.lastReadAt.getTime() >= cutoff) {
      readOf.set(row.projectId, (readOf.get(row.projectId) ?? 0) + 1);
    }
  }
  const mineOf = new Map(mine.map((m) => [m.projectId, m]));
  const blocked = await blockedAuthors(userId);
  return rows.filter((row) => !blocked.has(row.ownerId)).map((row) => {
    const meta = metaOf(row.settings);
    const own = mineOf.get(row.id);
    const textAt = row.textUpdatedAt ?? row.updatedAt;
    return {
      id: row.id,
      title: row.name,
      description: row.description ?? '',
      authorId: row.ownerId,
      authorName: row.authorName?.trim() || 'Автор',
      genres: meta.genres,
      genreNames: meta.genres.map(genreName),
      tags: meta.tags,
      status: meta.status,
      cycle: meta.cycle,
      authorNote: meta.authorNote,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      textUpdatedAt: textAt.toISOString(),
      words: Number(row.words) || 0,
      chapters: Number(row.chapters) || 0,
      views: viewOf.get(row.id) ?? 0,
      likes: likeOf.get(row.id) ?? 0,
      favorites: favOf.get(row.id) ?? 0,
      readingNow: readOf.get(row.id) ?? 0,
      liked: own?.liked ?? false,
      disliked: own?.disliked ?? false,
      favorite: own?.favorite ?? false,
      reading: Boolean(own?.lastReadAt),
      shelf: shelfOf(own?.shelf),
      cover: meta.cover,
      structure: meta.structure,
    };
  });
}

function byDate(value: string): number {
  return new Date(value).getTime();
}

const commentSchema = z.object({
  body: z.string().trim().min(1).max(2000),
  chapterId: z.string().max(80).optional(),
});
const flagSchema = z.object({ on: z.boolean().optional() });
const shelfSchema = z.object({
  shelf: z.enum(['', 'reading', 'later', 'done', 'skip']),
});

function shelfOf(value: string | undefined): BookCard['shelf'] {
  if (value === 'reading' || value === 'later' || value === 'done' || value === 'skip') return value;
  return '';
}

export const catalogRoutes: FastifyPluginAsync = async (app) => {
  app.get('/api/catalog/genres', async () => ({ genres: GENRES }));

  app.get('/api/catalog/authors', async () => {
    const books = await loadBooks(null);
    const map = new Map<string, { id: string; name: string; books: number }>();
    for (const book of books) {
      const row = map.get(book.authorId) ?? { id: book.authorId, name: book.authorName, books: 0 };
      row.books += 1;
      map.set(book.authorId, row);
    }
    return { authors: [...map.values()].sort((a, b) => a.name.localeCompare(b.name, 'ru')) };
  });

  app.get('/api/me/library', async (req) => {
    app.requireAuth(req);
    const books = await loadBooks(req.user!.id);
    return {
      favorites: books.filter((book) => book.favorite),
      reading: books.filter((book) => book.shelf === 'reading' || (!book.shelf && book.reading)),
      later: books.filter((book) => book.shelf === 'later'),
      done: books.filter((book) => book.shelf === 'done'),
      skipped: books.filter((book) => book.shelf === 'skip'),
      liked: books.filter((book) => book.liked),
    };
  });

  app.get('/api/catalog/home', async (req) => {
    const books = await loadBooks(req.user?.id ?? null);
    const take = (list: BookCard[]) => list.slice(0, 12);
    const fresh = books.filter((b) => Date.now() - byDate(b.createdAt) < 90 * 86400000);
    const mine = books.filter((b) => b.favorite);
    return {
      shelves: {
        popular: take([...books].sort((a, b) => b.views - a.views || b.words - a.words)),
        hot: take((fresh.length ? fresh : books).slice().sort((a, b) => b.views - a.views || byDate(b.createdAt) - byDate(a.createdAt))),
        updates: take([...books].sort((a, b) => byDate(b.textUpdatedAt) - byDate(a.textUpdatedAt))),
        bestsellers: take([...books].sort((a, b) => b.likes - a.likes || b.views - a.views || b.words - a.words)),
        arrivals: take([...books].sort((a, b) => byDate(b.createdAt) - byDate(a.createdAt))),
        reading: take([...books].sort((a, b) => b.readingNow - a.readingNow || byDate(b.textUpdatedAt) - byDate(a.textUpdatedAt))),
        liked: take([...books].sort((a, b) => b.likes - a.likes || b.favorites - a.favorites)),
        favorites: take(mine.length ? mine : [...books].sort((a, b) => b.favorites - a.favorites || b.likes - a.likes)),
      },
    };
  });

  app.get<{ Querystring: Record<string, string | undefined> }>('/api/catalog/search', async (req) => {
    const q = (req.query.q ?? '').trim().toLowerCase();
    const genre = req.query.genre ?? '';
    const status = req.query.status ?? '';
    const author = (req.query.author ?? '').trim().toLowerCase();
    const tag = (req.query.tag ?? '').trim().toLowerCase();
    const sort = req.query.sort ?? 'popular';
    const minWords = Number(req.query.minWords ?? 0) || 0;
    const maxWords = Number(req.query.maxWords ?? 0) || 0;
    const allowed = genre ? new Set(expandGenre(genre)) : null;
    let books = await loadBooks(req.user?.id ?? null);
    books = books.filter((book) => {
      if (allowed && !book.genres.some((id) => allowed.has(id))) return false;
      if (status && book.status !== status) return false;
      if (author && !book.authorName.toLowerCase().includes(author)) return false;
      if (tag && !book.tags.some((t) => t.toLowerCase().includes(tag)) && !book.genreNames.some((t) => t.toLowerCase().includes(tag))) return false;
      if (minWords && book.words < minWords) return false;
      if (maxWords && book.words > maxWords) return false;
      if (!q) return true;
      const hay = [book.title, book.authorName, book.description, book.cycle, ...book.tags, ...book.genreNames].join(' ').toLowerCase();
      return hay.includes(q);
    });
    books.sort((a, b) => {
      if (sort === 'new') return byDate(b.createdAt) - byDate(a.createdAt);
      if (sort === 'updated') return byDate(b.textUpdatedAt) - byDate(a.textUpdatedAt);
      if (sort === 'likes') return b.likes - a.likes || b.views - a.views;
      if (sort === 'words') return b.words - a.words;
      return b.views - a.views || b.likes - a.likes || b.words - a.words;
    });
    return { books };
  });

  app.get('/api/catalog/tops', async (req) => {
    const books = await loadBooks(req.user?.id ?? null);
    const authors = new Map<string, { id: string; name: string; books: number; words: number; likes: number; views: number }>();
    for (const book of books) {
      const row = authors.get(book.authorId) ?? { id: book.authorId, name: book.authorName, books: 0, words: 0, likes: 0, views: 0 };
      row.books += 1;
      row.words += book.words;
      row.likes += book.likes;
      row.views += book.views;
      authors.set(book.authorId, row);
    }
    return {
      authors: [...authors.values()].sort((a, b) => b.likes - a.likes || b.views - a.views || b.words - a.words).slice(0, 30),
      byLikes: [...books].sort((a, b) => b.likes - a.likes || b.views - a.views || b.words - a.words).slice(0, 30),
      byViews: [...books].sort((a, b) => b.views - a.views || b.likes - a.likes || b.words - a.words).slice(0, 30),
    };
  });

  app.get<{ Params: { id: string } }>('/api/catalog/books/:id', async (req, reply) => {
    const books = await loadBooks(req.user?.id ?? null);
    const book = books.find((b) => b.id === req.params.id);
    if (!book) return reply.status(404).send({ error: 'Книга не опубликована' });
    const [chapters, comments, authorBooks] = await Promise.all([
      prisma.chapter.findMany({
        where: { projectId: book.id },
        select: { id: true, title: true, kind: true, parentId: true, orderIndex: true, wordCount: true },
        orderBy: [{ orderIndex: 'asc' }, { createdAt: 'asc' }],
      }),
      prisma.bookComment.findMany({
        where: { projectId: book.id },
        orderBy: { createdAt: 'desc' },
        take: 40,
      }),
      prisma.project.count({
        where: { ownerId: book.authorId, settings: { path: ['catalog', 'published'], equals: true } },
      }),
    ]);
    const genreSet = new Set(book.genres);
    const similar = books.filter((other) => other.id !== book.id && other.genres.some((id) => genreSet.has(id))).slice(0, 6);
    return { book, chapters, comments, authorBooks, similar };
  });

  app.get<{ Params: { id: string; chapterId: string } }>('/api/catalog/books/:id/chapters/:chapterId', async (req, reply) => {
    const project = await prisma.project.findUnique({ where: { id: req.params.id }, select: { settings: true } });
    if (!metaPublished(project?.settings)) return reply.status(404).send({ error: 'Книга не опубликована' });
    const chapter = await prisma.chapter.findFirst({
      where: { id: req.params.chapterId, projectId: req.params.id },
      select: { id: true, title: true, content: true, wordCount: true, kind: true },
    });
    if (!chapter) return reply.status(404).send({ error: 'Глава не найдена' });
    if (req.user) {
      await prisma.bookReaction.upsert({
        where: { userId_projectId: { userId: req.user.id, projectId: req.params.id } },
        create: { userId: req.user.id, projectId: req.params.id, lastReadAt: new Date() },
        update: { lastReadAt: new Date() },
      });
    }
    return { chapter };
  });

  app.post<{ Params: { id: string } }>('/api/catalog/books/:id/view', async (req, reply) => {
    const project = await prisma.project.findUnique({ where: { id: req.params.id }, select: { settings: true } });
    if (!metaPublished(project?.settings)) return reply.status(404).send({ error: 'Книга не опубликована' });
    await prisma.bookView.create({ data: { projectId: req.params.id } });
    return reply.status(201).send({ ok: true });
  });

  app.post<{ Params: { id: string } }>('/api/catalog/books/:id/like', async (req) => {
    app.requireAuth(req);
    const on = await toggleFlag(req.params.id, req.user!.id, 'liked', flagSchema.parse(req.body ?? {}).on);
    if (on) {
      await prisma.bookReaction.update({
        where: { userId_projectId: { userId: req.user!.id, projectId: req.params.id } },
        data: { disliked: false },
      });
    }
    return { liked: on };
  });

  app.post<{ Params: { id: string } }>('/api/catalog/books/:id/dislike', async (req) => {
    app.requireAuth(req);
    const on = await toggleFlag(req.params.id, req.user!.id, 'disliked', flagSchema.parse(req.body ?? {}).on);
    if (on) {
      await prisma.bookReaction.update({
        where: { userId_projectId: { userId: req.user!.id, projectId: req.params.id } },
        data: { liked: false },
      });
    }
    return { disliked: on };
  });

  app.post<{ Params: { id: string } }>('/api/catalog/books/:id/shelf', async (req) => {
    app.requireAuth(req);
    const { shelf } = shelfSchema.parse(req.body ?? {});
    await ensurePublished(req.params.id);
    await prisma.bookReaction.upsert({
      where: { userId_projectId: { userId: req.user!.id, projectId: req.params.id } },
      create: { userId: req.user!.id, projectId: req.params.id, shelf },
      update: { shelf },
    });
    return { shelf };
  });

  app.post<{ Params: { id: string } }>('/api/catalog/books/:id/favorite', async (req) => {
    app.requireAuth(req);
    const on = await toggleFlag(req.params.id, req.user!.id, 'favorite', flagSchema.parse(req.body ?? {}).on);
    return { favorite: on };
  });

  app.post<{ Params: { id: string } }>('/api/catalog/books/:id/comments', async (req, reply) => {
    app.requireAuth(req);
    const project = await prisma.project.findUnique({ where: { id: req.params.id }, select: { settings: true } });
    if (!metaPublished(project?.settings)) return reply.status(404).send({ error: 'Книга не опубликована' });
    const input = commentSchema.parse(req.body);
    const comment = await prisma.bookComment.create({
      data: {
        projectId: req.params.id,
        userId: req.user!.id,
        authorName: req.user!.name?.trim() || 'Читатель',
        body: input.body,
        chapterId: input.chapterId ?? '',
      },
    });
    return reply.status(201).send({ comment });
  });

  app.post<{ Params: { id: string } }>('/api/catalog/books/:id/reports', async (req, reply) => {
    app.requireAuth(req);
    const project = await prisma.project.findUnique({
      where: { id: req.params.id },
      select: { settings: true, ownerId: true },
    });
    if (!metaPublished(project?.settings) || !project) return reply.status(404).send({ error: 'Книга не опубликована' });
    const input = readerReportCreateSchema.parse(req.body);
    const chapter = await prisma.chapter.findFirst({
      where: { id: input.chapterId, projectId: req.params.id },
      select: { id: true },
    });
    if (!chapter) return reply.status(404).send({ error: 'Глава не найдена' });
    const report = await prisma.readerReport.create({
      data: {
        projectId: req.params.id,
        chapterId: chapter.id,
        authorId: project.ownerId,
        quote: input.quote,
        note: input.note ?? '',
      },
    });
    return reply.status(201).send({ report });
  });
};

function metaPublished(settings: unknown): boolean {
  if (!settings || typeof settings !== 'object') return false;
  const catalog = (settings as { catalog?: { published?: unknown } }).catalog;
  return catalog?.published === true;
}

async function ensurePublished(projectId: string) {
  const project = await prisma.project.findUnique({ where: { id: projectId }, select: { settings: true } });
  if (!metaPublished(project?.settings)) {
    const err = new Error('Книга не опубликована') as Error & { statusCode?: number };
    err.statusCode = 404;
    throw err;
  }
}

async function toggleFlag(projectId: string, userId: string, field: 'liked' | 'disliked' | 'favorite', explicit?: boolean): Promise<boolean> {
  await ensurePublished(projectId);
  const current = await prisma.bookReaction.findUnique({ where: { userId_projectId: { userId, projectId } } });
  const next = explicit ?? !(current?.[field] ?? false);
  await prisma.bookReaction.upsert({
    where: { userId_projectId: { userId, projectId } },
    create: { userId, projectId, [field]: next },
    update: { [field]: next },
  });
  return next;
}
