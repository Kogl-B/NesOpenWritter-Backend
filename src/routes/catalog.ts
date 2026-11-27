import { createHash } from 'node:crypto';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { Prisma } from '@prisma/client';

import { prisma } from '../lib/prisma.js';
import { GENRES, genreName } from '../lib/genres.js';
import { readerReportCreateSchema } from '../lib/schemas.js';
import { scoreChapters } from '../lib/aiMarks.js';
import { chapterIsHidden } from '../lib/publish/visibility.js';
import { bookBlocked, chapterBlocked, postBlocked } from '../lib/geo/policy.js';
import { countryBlocks, denyCatalogGeo, denyGeo } from '../lib/geo/request.js';
import { bookDigestKey, bookSubscriptionNotice, commentNotices, digestDay, readerReportNotice } from '../lib/notify/drafts.js';
import { writeDigest, writeNotices } from '../lib/notify/deliver.js';
import { coverHref } from '../lib/ai/place.js';
import { homeCatalog, searchAuthors, searchCatalog, suggestBookIds, topCatalog, type CatalogVisibility, type HomeShelf } from '../lib/catalogBrowse.js';
import { viewerBlocks } from '../lib/viewerBlocks.js';
import { bookCycle, cycleSettings, inCycleOrder } from '../lib/bookCycles.js';
import { positionSchema, recentReadingPositions, saveReadingPosition } from '../lib/readingPositions.js';
import { readerAccessOf } from '../lib/readerAccess.js';
import { cachedReaderPages, pageHeight, PAGE_WIDTH, readerPages, renderReaderPage } from '../lib/protectedReader.js';
import { generateEpub } from '../lib/exporters.js';
import { chapterBlocks } from '../lib/publish/text.js';
import { projectFootnotes, footnoteLines } from '../lib/footnoteText.js';
import { directoryCard, directoryId, findDirectoryReference, publicDirectoryContent } from '../lib/worldDirectory.js';
import { captureError } from '../lib/sentry.js';
import { blockedAutomation, ROBOTS_TAG } from '../lib/botPolicy.js';

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
  cycleOrder: number | null;
  cycleBranch: string;
  cycleEntry: boolean;
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
  subscribed: boolean;
  cover: string;
  structure: 'chapters' | 'chapters-scenes';
  protectCopy: boolean;
  allowDownload: boolean;
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
    ...cycleSettings(catalog),
    authorNote: typeof catalog.authorNote === 'string' ? catalog.authorNote : '',
    cover: coverHref(root.cover),
    structure: root.structure === 'chapters' ? 'chapters' as const : 'chapters-scenes' as const,
  };
}

async function loadBooks(userId: string | null, selectedIds?: string[], ownerId?: string): Promise<BookCard[]> {
  if (selectedIds?.length === 0) return [];
  const scope = selectedIds ? Prisma.sql`AND p.id = ANY(${selectedIds}::text[])` : Prisma.empty;
  const owner = ownerId ? Prisma.sql`AND p."ownerId" = ${ownerId}` : Prisma.empty;
  const rows = await prisma.$queryRaw<RawBook[]>`
    SELECT p.id, p.name, p.description, p.settings, p."ownerId",
           u.name AS "authorName", p."createdAt", p."updatedAt",
           COALESCE(SUM(c."wordCount"), 0)::int AS words,
           COUNT(c.id)::int AS chapters,
           MAX(c."updatedAt") AS "textUpdatedAt"
    FROM projects p
    JOIN users u ON u.id = p."ownerId"
    LEFT JOIN chapters c ON c."projectId" = p.id
      AND COALESCE(c.metadata->>'public', '') <> 'false'
    WHERE COALESCE(p.settings #>> '{catalog,published}', '') = 'true' ${scope} ${owner}
    GROUP BY p.id, u.name
  `;
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const cutoff = new Date(Date.now() - 14 * 86_400_000);
  const [views, mine, subs, reactions] = await Promise.all([
    prisma.bookView.groupBy({ by: ['projectId'], where: { projectId: { in: ids } }, _count: { _all: true } }),
    userId
      ? prisma.bookReaction.findMany({ where: { userId, projectId: { in: ids } } })
      : Promise.resolve([]),
    userId
      ? prisma.bookSubscription.findMany({ where: { userId, projectId: { in: ids } }, select: { projectId: true } })
      : Promise.resolve([]),
    prisma.$queryRaw<Array<{ projectId: string; likes: number; favorites: number; readingNow: number }>>`
      SELECT "projectId", count(*) FILTER (WHERE liked)::int AS likes,
             count(*) FILTER (WHERE favorite)::int AS favorites,
             count(*) FILTER (WHERE "lastReadAt" >= ${cutoff})::int AS "readingNow"
      FROM book_reactions WHERE "projectId" = ANY(${ids}::text[]) GROUP BY "projectId"
    `,
  ]);
  const viewOf = new Map(views.map((v) => [v.projectId, v._count._all]));
  const reactionsOf = new Map(reactions.map((row) => [row.projectId, row]));
  const mineOf = new Map(mine.map((m) => [m.projectId, m]));
  const subscribed = new Set(subs.map((row) => row.projectId));
  const blocked = await viewerBlocks(userId);
  return rows.filter((row) => !blocked.people.has(row.ownerId) && !blocked.books.has(row.id)).map((row) => {
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
      cycleOrder: meta.cycleOrder,
      cycleBranch: meta.cycleBranch,
      cycleEntry: meta.cycleEntry,
      authorNote: meta.authorNote,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      textUpdatedAt: textAt.toISOString(),
      words: Number(row.words) || 0,
      chapters: Number(row.chapters) || 0,
      views: viewOf.get(row.id) ?? 0,
      likes: reactionsOf.get(row.id)?.likes ?? 0,
      favorites: reactionsOf.get(row.id)?.favorites ?? 0,
      readingNow: reactionsOf.get(row.id)?.readingNow ?? 0,
      liked: own?.liked ?? false,
      disliked: own?.disliked ?? false,
      favorite: own?.favorite ?? false,
      reading: Boolean(own?.lastReadAt),
      shelf: shelfOf(own?.shelf),
      subscribed: subscribed.has(row.id),
      cover: meta.cover,
      structure: meta.structure,
      ...readerAccessOf(row.settings),
    };
  });
}

const shortQuery = z.string().max(512).optional();
const pageQuery = z.coerce.number().int().min(1).max(10_000).default(1);
const authorSearchQuery = z.object({ q: shortQuery, page: pageQuery });
const catalogSearchQuery = z.object({
  q: shortQuery, genre: shortQuery, status: shortQuery, author: shortQuery, tag: shortQuery,
  excludeTag: shortQuery, cycle: shortQuery, sort: shortQuery, minWords: shortQuery, maxWords: shortQuery,
  minPages: shortQuery, maxPages: shortQuery, size: shortQuery, updatedDays: shortQuery,
  page: pageQuery,
});

async function catalogVisibility(req: FastifyRequest): Promise<CatalogVisibility> {
  const userId = req.user?.id ?? null;
  const [blocked, geo] = await Promise.all([viewerBlocks(userId), countryBlocks(req)]);
  const excluded = new Set(blocked.books);
  if (geo.country) {
    for (const [id, countries] of geo.index.books) {
      if (countries.has(geo.country)) excluded.add(id);
    }
  }
  return { userId, excludedBooks: [...excluded], excludedAuthors: [...blocked.people] };
}

async function catalogCards(userId: string | null, ids: string[]) {
  return new Map((await loadBooks(userId, [...new Set(ids)])).map((book) => [book.id, book]));
}

function orderedCards(ids: string[], cards: Map<string, BookCard>): BookCard[] {
  return ids.flatMap((id) => {
    const book = cards.get(id);
    return book ? [book] : [];
  });
}

const commentSchema = z.object({
  body: z.string().trim().min(1).max(2000),
  chapterId: z.string().max(80).optional(),
  parentId: z.string().trim().max(64).optional(),
});
const flagSchema = z.object({ on: z.boolean().optional() });
const shelfSchema = z.object({
  shelf: z.enum(['', 'reading', 'later', 'done', 'skip']),
});

function shelfOf(value: string | undefined): BookCard['shelf'] {
  if (value === 'reading' || value === 'later' || value === 'done' || value === 'skip') return value;
  return '';
}

function publicAudio(metadata: unknown): { url: string; title: string } | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const audio = (metadata as Record<string, unknown>).audio;
  if (!audio || typeof audio !== 'object') return null;
  const url = (audio as Record<string, unknown>).url;
  if (typeof url !== 'string' || url.length > 500) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (parsed.username || parsed.password) return null;
  const titleRaw = (audio as Record<string, unknown>).title;
  const title = typeof titleRaw === 'string' ? titleRaw.trim().slice(0, 80) : '';
  return { url: parsed.toString(), title };
}

async function publicReading(req: FastifyRequest, reply: FastifyReply, id: string) {
  reply.header('Cache-Control', 'private, no-store');
  const project = await prisma.project.findUnique({ where: { id }, select: { name: true, settings: true, ownerId: true } });
  if (!project || !metaPublished(project.settings)) {
    reply.status(404).send({ error: 'Книга не опубликована' });
    return null;
  }
  const [blocks, geo] = await Promise.all([viewerBlocks(req.user?.id ?? null), countryBlocks(req)]);
  if (blocks.books.has(id) || blocks.people.has(project.ownerId)) {
    reply.status(404).send({ error: 'Книга не опубликована' });
    return null;
  }
  if (bookBlocked(geo.index, geo.country, id)) {
    await denyGeo(reply);
    return null;
  }
  return { project, geo, access: readerAccessOf(project.settings) };
}

function readerFailure(req: FastifyRequest, reply: FastifyReply, err: unknown, projectId: string, chapterId: string) {
  const context = { code: 'PROTECTED_READER_FAILED', projectId, chapterId, requestId: req.id };
  req.log.error({ err, ...context }, 'Не удалось отобразить защищённую главу');
  captureError(err, context);
  return reply.status(503).send({ error: 'Не удалось открыть защищённую главу.' });
}

function readingChapters<T extends { id: string; kind: string; parentId: string | null }>(rows: T[]) {
  const scenesByChapter = new Map(rows.filter((row) => row.kind === 'chapter').map((row) => [row.id, [] as T[]]));
  const standalone = rows.filter((row) => {
    const scenes = row.kind === 'scene' && row.parentId ? scenesByChapter.get(row.parentId) : undefined;
    if (!scenes) return true;
    scenes.push(row);
    return false;
  });
  return standalone.map((chapter) => ({ chapter, scenes: scenesByChapter.get(chapter.id) ?? [] }));
}

type PublicChapterOutline = {
  id: string;
  title: string;
  kind: string;
  parentId: string | null;
  orderIndex: number;
  wordCount: number;
  metadata: unknown;
  hasText: boolean;
};

const visibleCharacter = '[^[:space:]\u00a0\u200b]';
const nonBlank = JSON.stringify(visibleCharacter);
const readableNodes = '$.content.** ? ('
  + '(@.type == "text" && @.text like_regex ' + nonBlank + ')'
  + ' || (@.type == "image" && @.attrs.src like_regex ' + nonBlank + ')'
  + ' || (@.type == "directoryReference" && @.attrs.id like_regex ' + nonBlank + ')'
  + ')';

function publicChapterOutline(projectId: string) {
  return prisma.$queryRaw<PublicChapterOutline[]>`
    SELECT id, title, kind, "parentId", "orderIndex", "wordCount", metadata,
           CASE jsonb_typeof(content)
             WHEN 'string' THEN (content #>> '{}') ~ ${visibleCharacter}
             WHEN 'object' THEN jsonb_path_exists(content, ${readableNodes}::jsonpath)
             ELSE false
           END AS "hasText"
    FROM chapters
    WHERE "projectId" = ${projectId}
    ORDER BY "orderIndex", "createdAt", id
  `;
}

const chapterContentFields = {
  id: true, title: true, content: true, wordCount: true, kind: true, parentId: true, metadata: true, updatedAt: true,
} as const;
const readingOrder = [{ orderIndex: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }] as const;

export const catalogRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', async (req, reply) => {
    reply.header('X-Robots-Tag', ROBOTS_TAG);
    if (blockedAutomation(req.headers['user-agent'])) return reply.status(403).send({ error: 'Автоматизированный доступ запрещён.' });
  });
  app.addHook('preHandler', async (req, reply) => {
    if (await denyCatalogGeo(req, reply)) return reply;
  });

  app.get('/api/catalog/genres', async () => ({ genres: GENRES }));

  app.get('/api/catalog/authors', async (req) => {
    const books = await hideBooks(req, await loadBooks(null));
    const map = new Map<string, { id: string; name: string; books: number }>();
    for (const book of books) {
      const row = map.get(book.authorId) ?? { id: book.authorId, name: book.authorName, books: 0 };
      row.books += 1;
      map.set(book.authorId, row);
    }
    return { authors: [...map.values()].sort((a, b) => a.name.localeCompare(b.name, 'ru')) };
  });

  app.get<{ Params: { id: string } }>('/api/catalog/authors/:id', async (req, reply) => {
    const author = await prisma.user.findUnique({
      where: { id: req.params.id },
      select: { id: true, name: true, image: true, createdAt: true, settings: true },
    });
    if (!author) return reply.status(404).send({ error: 'Автор не найден' });
    const viewerId = req.user?.id ?? null;
    const [geo, authoredRaw, libraryRows] = await Promise.all([
      countryBlocks(req),
      loadBooks(viewerId, undefined, author.id),
      prisma.bookReaction.findMany({
        where: { userId: author.id, OR: [{ favorite: true }, { shelf: { not: '' } }] },
        select: { projectId: true },
      }),
    ]);
    const keepBook = (book: BookCard) => !bookBlocked(geo.index, geo.country, book.id);
    const mine = (await loadBooks(author.id, libraryRows.map(row => row.projectId))).filter(keepBook);
    const books = authoredRaw.filter(keepBook);
    const ids = new Set(books.map((book) => book.id));
    const blocks = await viewerBlocks(viewerId);
    const [posts, comments, followers, following] = await Promise.all([
      prisma.blogPost.findMany({
        where: {
          authorId: author.id,
          published: true,
          ...(viewerId === author.id ? {} : { audience: { not: 'self' } }),
        },
        orderBy: { createdAt: 'desc' },
        take: 40,
        select: {
          id: true,
          title: true,
          body: true,
          topic: true,
          createdAt: true,
          views: true,
          _count: { select: { comments: true, likes: true } },
        },
      }),
      ids.size === 0
        ? Promise.resolve([])
        : prisma.bookComment.findMany({
          where: { projectId: { in: [...ids] } },
          orderBy: { createdAt: 'desc' },
          take: 40,
        }),
      prisma.authorFollow.count({ where: { authorId: author.id } }),
      viewerId
        ? prisma.authorFollow.findUnique({ where: { userId_authorId: { userId: viewerId, authorId: author.id } } })
        : Promise.resolve(null),
    ]);
    const titleOf = new Map(books.map((book) => [book.id, book.title]));
    const shelf = (value: BookCard['shelf']) => mine.filter((book) => book.shelf === value);
    return {
      author: {
        id: author.id,
        name: author.name?.trim() || 'Автор',
        image: author.image && author.image.length <= 220_000 ? author.image : '',
        createdAt: author.createdAt.toISOString(),
        about: aboutOf(author.settings),
        books: books.length,
        words: books.reduce((sum, book) => sum + book.words, 0),
        followers,
        following: Boolean(following),
      },
      books,
      posts: posts.filter((post) => (
        !postBlocked(geo.index, geo.country, post.id)
        && !blocks.blogs.has(post.id)
        && !blocks.people.has(author.id)
      )).map((post) => ({
        id: post.id,
        title: post.title,
        topic: post.topic,
        excerpt: plainExcerpt(post.body),
        createdAt: post.createdAt.toISOString(),
        views: post.views,
        comments: post._count.comments,
        likes: post._count.likes,
      })),
      library: {
        reading: shelf('reading'),
        later: shelf('later'),
        done: shelf('done'),
        skipped: shelf('skip'),
        favorites: mine.filter((book) => book.favorite),
      },
      cycles: cyclesOf(books),
      reviews: comments.map((row) => ({
        id: row.id,
        bookId: row.projectId,
        bookTitle: titleOf.get(row.projectId) ?? 'Книга',
        authorName: row.authorName || 'Читатель',
        body: row.body,
        createdAt: row.createdAt.toISOString(),
      })),
    };
  });

  app.get('/api/me/book-subscriptions', async (req) => {
    app.requireAuth(req);
    const [rows, loaded] = await Promise.all([
      prisma.bookSubscription.findMany({
        where: { userId: req.user!.id },
        orderBy: { createdAt: 'desc' },
        select: { projectId: true, createdAt: true },
      }),
      loadBooks(req.user!.id),
    ]);
    const books = await hideBooks(req, loaded);
    const byId = new Map(books.map((book) => [book.id, book]));
    return {
      books: rows.flatMap((row) => {
        const book = byId.get(row.projectId);
        return book ? [{ ...book, subscribedAt: row.createdAt.toISOString() }] : [];
      }),
    };
  });

  app.get('/api/me/library', async (req) => {
    app.requireAuth(req);
    const books = await hideBooks(req, await loadBooks(req.user!.id));
    return {
      favorites: books.filter((book) => book.favorite),
      reading: books.filter((book) => book.shelf === 'reading' || (!book.shelf && book.reading)),
      later: books.filter((book) => book.shelf === 'later'),
      done: books.filter((book) => book.shelf === 'done'),
      skipped: books.filter((book) => book.shelf === 'skip'),
      liked: books.filter((book) => book.liked),
    };
  });

  app.get('/api/catalog/home', { config: { rateLimit: { max: 90 } } }, async (req, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    const scope = await catalogVisibility(req);
    const { recommended, ...shelves } = await homeCatalog(scope, Date.now());
    const cards = await catalogCards(scope.userId, [recommended, ...Object.values(shelves)].flat());
    return {
      recommended: orderedCards(recommended, cards),
      shelves: Object.fromEntries((Object.entries(shelves) as [HomeShelf, string[]][])
        .map(([name, ids]) => [name, orderedCards(ids, cards)])),
    };
  });

  app.get('/api/catalog/search', { config: { rateLimit: { max: 60 } } }, async (req, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    const { page, ...query } = catalogSearchQuery.parse(req.query);
    const scope = await catalogVisibility(req);
    const { ids, ...result } = await searchCatalog(scope, query, page, Date.now());
    const cards = await catalogCards(scope.userId, ids);
    return { ...result, books: orderedCards(ids, cards) };
  });

  app.get('/api/catalog/search/authors', { config: { rateLimit: { max: 60 } } }, async (req, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    const { q = '', page } = authorSearchQuery.parse(req.query);
    return searchAuthors(await catalogVisibility(req), q, page);
  });

  app.get('/api/catalog/suggest', { config: { rateLimit: { max: 120 } } }, async (req, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    const { q = '' } = z.object({ q: z.string().trim().max(160).optional() }).parse(req.query);
    if (Array.from(q.replace(/^@/, '')).length < 2) return { books: [], authors: [] };
    const scope = await catalogVisibility(req);
    const [ids, { authors }] = await Promise.all([
      suggestBookIds(scope, q, Date.now()),
      searchAuthors(scope, q, 1, 4),
    ]);
    const cards = await catalogCards(scope.userId, ids);
    const books = orderedCards(ids, cards).map(({ id, title, cover, authorName }) => ({
      id, title, cover: cover.length <= 2048 ? cover : '', authorName,
    }));
    return { books, authors };
  });

  app.get('/api/catalog/continue', async (req, reply) => {
    app.requireAuth(req);
    reply.header('Cache-Control', 'private, no-store');
    const { book } = z.object({ book: z.string().min(1).max(128).optional() }).parse(req.query);
    const [scope, geo] = await Promise.all([catalogVisibility(req), countryBlocks(req)]);
    const chapters = [...geo.index.chapters].filter(([, countries]) => geo.country && countries.has(geo.country)).map(([id]) => id);
    return { positions: await recentReadingPositions(req.user!.id, book, {
      books: scope.excludedBooks, authors: scope.excludedAuthors, chapters,
    }) };
  });

  app.put<{ Params: { id: string } }>('/api/catalog/books/:id/position', { config: { rateLimit: { max: 120 } } }, async (req, reply) => {
    app.requireAuth(req);
    const point = positionSchema.parse(req.body);
    const { id } = req.params;
    const scope = await publicReading(req, reply, id);
    if (!scope) return reply;
    const chapter = await prisma.chapter.findFirst({ where: { id: point.chapterId, projectId: id }, select: { metadata: true } });
    if (!chapter || chapterIsHidden(chapter.metadata)) return reply.status(404).send({ error: 'Глава недоступна' });
    if (chapterBlocked(scope.geo.index, scope.geo.country, id, point.chapterId)) return denyGeo(reply);
    await saveReadingPosition(req.user!.id, id, point);
    return reply.status(204).send();
  });

  app.get('/api/catalog/tops', { config: { rateLimit: { max: 90 } } }, async (req, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    const scope = await catalogVisibility(req);
    const { authors, byLikes, byViews } = await topCatalog(scope, Date.now());
    const cards = await catalogCards(scope.userId, [...byLikes, ...byViews]);
    return { authors, byLikes: orderedCards(byLikes, cards), byViews: orderedCards(byViews, cards) };
  });

  app.get<{ Params: { id: string } }>('/api/catalog/books/:id', async (req, reply) => {
    const geo = await countryBlocks(req);
    const books = await loadBooks(req.user?.id ?? null);
    const book = books.find((b) => b.id === req.params.id);
    if (!book) return reply.status(404).send({ error: 'Книга не опубликована' });
    if (bookBlocked(geo.index, geo.country, book.id)) return denyGeo(reply);
    const shelf = books.filter((item) => !bookBlocked(geo.index, geo.country, item.id));
    const [chapters, comments, marks] = await Promise.all([
      publicChapterOutline(book.id),
      prisma.bookComment.findMany({
        where: { projectId: book.id },
        orderBy: { createdAt: 'desc' },
        take: 40,
      }),
      prisma.chapter.findMany({
        where: { projectId: book.id },
        select: { id: true, parentId: true, kind: true, aiCreated: true, aiReviewed: true, metadata: true },
      }),
    ]);
    const openChapter = (row: { id: string; metadata: unknown }) => (
      !chapterIsHidden(row.metadata) && !chapterBlocked(geo.index, geo.country, book.id, row.id)
    );
    const visible = chapters.filter(openChapter);
    const visibleChapters = visible.map(({ metadata: _metadata, hasText, ...row }) => ({
      ...row,
      wordCount: hasText ? row.wordCount : 0,
    }));
    const reading = readingChapters(visible).flatMap(({ chapter, scenes }) => {
      const parts = [chapter, ...scenes];
      if (!parts.some((part) => part.hasText || publicAudio(part.metadata))) return [];
      return [{
        id: chapter.id,
        title: chapter.title,
        wordCount: parts.reduce((words, part) => words + (part.hasText ? part.wordCount : 0), 0),
        sceneIds: scenes.map((scene) => scene.id),
      }];
    });
    const visibleComments = comments.filter((row) => !row.chapterId || !chapterBlocked(geo.index, geo.country, book.id, row.chapterId));
    const parentNames = await commentParentNames(visibleComments.map((row) => row.parentId));
    const genreSet = new Set(book.genres);
    const publicBook = {
      ...book,
      words: reading.reduce((sum, chapter) => sum + chapter.wordCount, 0),
      chapters: reading.length,
    };
    const series = bookCycle(book, shelf);
    return {
      book: publicBook,
      series: series && {
        ...series,
        books: series.books.map(({ id, title, cycleOrder, cycleBranch, cycleEntry, shelf }) => ({
          id, title, cycleOrder, cycleBranch, cycleEntry, shelf,
        })),
      },
      chapters: visibleChapters,
      readingChapters: reading,
      comments: visibleComments.map((row) => publicBookComment(row, row.parentId ? parentNames.get(row.parentId) ?? '' : '')),
      authorBooks: shelf.filter((item) => item.authorId === book.authorId).length,
      similar: shelf.filter((other) => other.id !== book.id && other.genres.some((id) => genreSet.has(id))).slice(0, 6),
      ai: scoreChapters(marks.filter(openChapter)),
    };
  });

  app.get<{ Params: { id: string; chapterId: string }; Querystring: { whole?: string } }>('/api/catalog/books/:id/chapters/:chapterId', async (req, reply) => {
    const { id, chapterId } = req.params;
    const scope = await publicReading(req, reply, id);
    if (!scope) return reply;
    const requested = await prisma.chapter.findFirst({
      where: { id: chapterId, projectId: id },
      select: chapterContentFields,
    });
    if (!requested || chapterIsHidden(requested.metadata)) return reply.status(404).send({ error: 'Глава не найдена' });
    if (chapterBlocked(scope.geo.index, scope.geo.country, id, chapterId)) return denyGeo(reply);
    const whole = req.query.whole === '1';
    const visible = (row: { id: string; metadata: unknown }) => (
      !chapterIsHidden(row.metadata) && !chapterBlocked(scope.geo.index, scope.geo.country, id, row.id)
    );
    let chapter = requested;
    if (whole && requested.kind === 'scene' && requested.parentId) {
      const parent = await prisma.chapter.findFirst({
        where: { id: requested.parentId, projectId: id, kind: 'chapter' },
        select: chapterContentFields,
      });
      if (parent && visible(parent)) chapter = parent;
    }
    const scenes = whole && chapter.kind === 'chapter'
      ? (await prisma.chapter.findMany({
        where: { projectId: id, parentId: chapter.id, kind: 'scene' },
        select: chapterContentFields,
        orderBy: [...readingOrder],
      })).filter(visible)
      : [];
    const parts = [chapter, ...scenes];
    const audio = publicAudio(requested.metadata)
      ?? parts.map((part) => publicAudio(part.metadata)).find(Boolean)
      ?? null;
    let pages: Array<{ src: string; raster: boolean; width?: number; height?: number }> | undefined;
    if (scope.access.protectCopy) {
      try {
        pages = parts.flatMap((part) =>
          readerPages(`${part.id}:${part.updatedAt.toISOString()}`, part.content).map((page, index) => ({
            src: `/api/catalog/books/${id}/chapters/${part.id}/pages/${index + 1}`,
            raster: page.kind === 'text',
            ...(page.kind === 'text' ? {
              width: PAGE_WIDTH, height: pageHeight(page.lines.length),
              ...(page.references.length && { references: page.references.map((reference) => ({ ...reference, chapterId: part.id })) }),
            } : {}),
          })),
        );
      } catch (err) {
        return readerFailure(req, reply, err, id, chapterId);
      }
    }
    if (req.user) {
      await prisma.bookReaction.upsert({
        where: { userId_projectId: { userId: req.user.id, projectId: id } },
        create: { userId: req.user.id, projectId: id, lastReadAt: new Date() },
        update: { lastReadAt: new Date() },
      });
    }
    return {
      chapter: {
        id: chapter.id,
        title: chapter.title,
        version: createHash('sha256').update(JSON.stringify([
          scope.access.protectCopy, ...parts.map(part => [part.id, part.updatedAt]),
        ])).digest('base64url').slice(0, 22),
        ...(pages ? { protectedPages: pages } : whole ? {
          contents: parts.map((part) => publicDirectoryContent(scope.project.settings, part.content)), contentChapterIds: parts.map((part) => part.id),
        } : { content: publicDirectoryContent(scope.project.settings, chapter.content) }),
        wordCount: parts.reduce((words, part) => words + part.wordCount, 0),
        kind: chapter.kind,
        audioUrl: audio?.url ?? null,
        audioTitle: audio?.title ?? '',
      },
    };
  });

  app.get<{ Params: { id: string; chapterId: string; referenceId: string } }>('/api/catalog/books/:id/chapters/:chapterId/directory/:referenceId', async (req, reply) => {
    const { id, chapterId, referenceId } = req.params;
    const scope = await publicReading(req, reply, id);
    if (!scope) return reply;
    const unavailable = () => reply.status(404).send({ error: 'Справочная запись недоступна.' });
    if (!directoryId.safeParse(referenceId).success) return unavailable();
    const chapter = await prisma.chapter.findFirst({
      where: { id: chapterId, projectId: id }, select: { metadata: true, content: true },
    });
    if (!chapter || chapterIsHidden(chapter.metadata)) return unavailable();
    if (chapterBlocked(scope.geo.index, scope.geo.country, id, chapterId)) return denyGeo(reply);
    const reference = findDirectoryReference(chapter.content, referenceId);
    const card = reference && await directoryCard(id, scope.project.settings, reference, {
      chapterId, isBlocked: (unitId) => chapterBlocked(scope.geo.index, scope.geo.country, id, unitId),
    });
    return card ? { card } : unavailable();
  });

  app.get<{ Params: { id: string; chapterId: string; page: string } }>('/api/catalog/books/:id/chapters/:chapterId/pages/:page', async (req, reply) => {
    const { id, chapterId, page } = req.params;
    const index = Number(page) - 1;
    if (!/^[1-9]\d*$/.test(page) || !Number.isSafeInteger(index)) return reply.status(404).send({ error: 'Страница не найдена' });
    const scope = await publicReading(req, reply, id);
    if (!scope) return reply;
    if (!scope.access.protectCopy) return reply.status(404).send({ error: 'Страница не найдена' });
    const chapter = await prisma.chapter.findFirst({
      where: { id: chapterId, projectId: id },
      select: { metadata: true, updatedAt: true },
    });
    if (!chapter || chapterIsHidden(chapter.metadata)) return reply.status(404).send({ error: 'Глава не найдена' });
    if (chapterBlocked(scope.geo.index, scope.geo.country, id, chapterId)) return denyGeo(reply);
    try {
      const key = `${chapterId}:${chapter.updatedAt.toISOString()}`;
      let pages = cachedReaderPages(key);
      if (!pages) {
        const content = await prisma.chapter.findFirst({
          where: { id: chapterId, projectId: id, updatedAt: chapter.updatedAt },
          select: { content: true },
        });
        if (!content) return reply.status(409).send({ error: 'Глава обновилась. Откройте её заново.' });
        pages = readerPages(key, content.content);
      }
      const visible = pages[index];
      if (!visible) return reply.status(404).send({ error: 'Страница не найдена' });
      if (visible.kind === 'text') return reply.type('image/png').send(await renderReaderPage(visible.lines, visible.references));
      const inline = /^data:(image\/[a-z]+);base64,(.+)$/i.exec(visible.src);
      if (inline) return reply.type(inline[1]!).send(Buffer.from(inline[2]!, 'base64'));
      return reply.redirect(visible.src);
    } catch (err) {
      return readerFailure(req, reply, err, id, chapterId);
    }
  });

  app.get<{ Params: { id: string } }>('/api/catalog/books/:id/download', async (req, reply) => {
    const { id } = req.params;
    const scope = await publicReading(req, reply, id);
    if (!scope) return reply;
    if (!scope.access.allowDownload) return reply.status(403).send({ error: 'Автор запретил скачивание книги.' });
    const rows = await prisma.chapter.findMany({
      where: { projectId: id },
      orderBy: [...readingOrder],
      select: { id: true, title: true, content: true, kind: true, parentId: true, wordCount: true, metadata: true },
    });
    const visible = rows.filter((row) => !chapterIsHidden(row.metadata) && !chapterBlocked(scope.geo.index, scope.geo.country, id, row.id));
    const chapters = readingChapters(visible).flatMap(({ chapter, scenes }) => {
      const parts = [chapter, ...scenes];
      const notes: string[] = [];
      const lines = parts.flatMap((row) => typeof row.content === 'string'
        ? [row.content.trim()] : chapterBlocks(projectFootnotes(publicDirectoryContent(scope.project.settings, row.content), notes)));
      const content = [...lines, ...footnoteLines(notes)].filter(Boolean).join('\n');
      const wordCount = Math.max(1, parts.reduce((sum, row) => sum + row.wordCount, 0));
      return content ? [{ id: chapter.id, title: chapter.title, kind: chapter.kind, content, wordCount }] : [];
    });
    if (!chapters.length) return reply.status(404).send({ error: 'В книге нет доступных глав.' });
    const file = generateEpub({
      projectName: scope.project.name,
      chapters,
      characters: [],
      locations: [],
    });
    const filename = encodeURIComponent(scope.project.name + '.epub').replace(/[!'()*]/g, (value) => `%${value.charCodeAt(0).toString(16).toUpperCase()}`);
    return reply.header('Content-Disposition', `attachment; filename="book.epub"; filename*=UTF-8''${filename}`)
      .type('application/epub+zip').send(file);
  });

  app.post<{ Params: { id: string } }>('/api/catalog/books/:id/view', async (req, reply) => {
    const project = await prisma.project.findUnique({ where: { id: req.params.id }, select: { settings: true } });
    if (!metaPublished(project?.settings)) return reply.status(404).send({ error: 'Книга не опубликована' });
    await prisma.bookView.create({ data: { projectId: req.params.id } });
    return reply.status(201).send({ ok: true });
  });

  app.post<{ Params: { id: string } }>('/api/catalog/books/:id/like', async (req) => {
    app.requireAuth(req);
    const prev = await prisma.bookReaction.findUnique({
      where: { userId_projectId: { userId: req.user!.id, projectId: req.params.id } },
      select: { liked: true },
    });
    const on = await toggleFlag(req.params.id, req.user!.id, 'liked', flagSchema.parse(req.body ?? {}).on);
    if (on) {
      await prisma.bookReaction.update({
        where: { userId_projectId: { userId: req.user!.id, projectId: req.params.id } },
        data: { disliked: false },
      });
    }
    if (on !== (prev?.liked ?? false)) await bookDigest(req.params.id, req.user!.id, 'likes', on);
    return { liked: on };
  });

  app.post<{ Params: { id: string } }>('/api/catalog/books/:id/dislike', async (req) => {
    app.requireAuth(req);
    const prev = await prisma.bookReaction.findUnique({
      where: { userId_projectId: { userId: req.user!.id, projectId: req.params.id } },
      select: { liked: true },
    });
    const on = await toggleFlag(req.params.id, req.user!.id, 'disliked', flagSchema.parse(req.body ?? {}).on);
    if (on) {
      await prisma.bookReaction.update({
        where: { userId_projectId: { userId: req.user!.id, projectId: req.params.id } },
        data: { liked: false },
      });
    }
    if (on && prev?.liked) await bookDigest(req.params.id, req.user!.id, 'likes', false);
    return { disliked: on };
  });

  app.post<{ Params: { id: string } }>('/api/catalog/books/:id/subscribe', async (req) => {
    app.requireAuth(req);
    await ensurePublished(req.params.id);
    const key = { userId: req.user!.id, projectId: req.params.id };
    const existing = await prisma.bookSubscription.findUnique({ where: { userId_projectId: key } });
    if (existing) {
      await prisma.bookSubscription.delete({ where: { userId_projectId: key } });
      return { subscribed: false };
    }
    await prisma.bookSubscription.create({ data: key });
    const [project, me] = await Promise.all([
      prisma.project.findUnique({ where: { id: req.params.id }, select: { ownerId: true, name: true } }),
      prisma.user.findUnique({ where: { id: req.user!.id }, select: { name: true } }),
    ]);
    if (project) {
      await writeNotices(bookSubscriptionNotice({
        ownerId: project.ownerId,
        actorId: req.user!.id,
        actorName: me?.name?.trim() || 'Читатель',
        projectId: req.params.id,
        bookTitle: project.name,
      }));
    }
    return { subscribed: true };
  });

  app.post<{ Params: { id: string } }>('/api/catalog/books/:id/shelf', async (req) => {
    app.requireAuth(req);
    const { shelf } = shelfSchema.parse(req.body ?? {});
    await ensurePublished(req.params.id);
    const prev = await prisma.bookReaction.findUnique({
      where: { userId_projectId: { userId: req.user!.id, projectId: req.params.id } },
      select: { shelf: true },
    });
    const favorite = shelf === 'reading' || shelf === 'later' || shelf === 'done';
    await prisma.bookReaction.upsert({
      where: { userId_projectId: { userId: req.user!.id, projectId: req.params.id } },
      create: { userId: req.user!.id, projectId: req.params.id, shelf, favorite },
      update: { shelf, favorite },
    });
    const reading = shelf === 'reading';
    if ((prev?.shelf === 'reading') !== reading) await bookDigest(req.params.id, req.user!.id, 'reading', reading);
    return { shelf, favorite };
  });

  app.post<{ Params: { id: string } }>('/api/catalog/books/:id/favorite', async (req) => {
    app.requireAuth(req);
    const on = await toggleFlag(req.params.id, req.user!.id, 'favorite', flagSchema.parse(req.body ?? {}).on);
    return { favorite: on };
  });

  app.post<{ Params: { id: string } }>('/api/catalog/books/:id/comments', async (req, reply) => {
    app.requireAuth(req);
    const project = await prisma.project.findUnique({
      where: { id: req.params.id },
      select: { settings: true, ownerId: true, name: true },
    });
    if (!metaPublished(project?.settings) || !project) return reply.status(404).send({ error: 'Книга не опубликована' });
    const input = commentSchema.parse(req.body);
    const geo = await countryBlocks(req);
    if (input.chapterId && chapterBlocked(geo.index, geo.country, req.params.id, input.chapterId)) return denyGeo(reply);
    const parentId = input.parentId ?? '';
    const parent = parentId
      ? await prisma.bookComment.findFirst({
        where: { id: parentId, projectId: req.params.id },
        select: { userId: true, authorName: true },
      })
      : null;
    if (parentId && !parent) return reply.status(400).send({ error: 'Комментарий для ответа не найден' });
    const comment = await prisma.bookComment.create({
      data: {
        projectId: req.params.id,
        userId: req.user!.id,
        authorName: req.user!.name?.trim() || 'Читатель',
        body: input.body,
        chapterId: input.chapterId ?? '',
        parentId,
      },
    });
    await writeNotices(commentNotices({
      target: 'book',
      actorId: req.user!.id,
      actorName: comment.authorName,
      ownerId: project.ownerId,
      parentUserId: parent?.userId ?? '',
      commentId: comment.id,
      subjectId: req.params.id,
      subjectTitle: project.name,
      body: comment.body,
    }));
    return reply.status(201).send({
      comment: publicBookComment(comment, parent?.authorName || ''),
    });
  });

  app.post<{ Params: { id: string } }>('/api/catalog/books/:id/reports', async (req, reply) => {
    app.requireAuth(req);
    const project = await prisma.project.findUnique({
      where: { id: req.params.id },
      select: { settings: true, ownerId: true, name: true },
    });
    if (!metaPublished(project?.settings) || !project) return reply.status(404).send({ error: 'Книга не опубликована' });
    const input = readerReportCreateSchema.parse(req.body);
    const chapter = await prisma.chapter.findFirst({
      where: { id: input.chapterId, projectId: req.params.id },
      select: { id: true, metadata: true },
    });
    if (!chapter || chapterIsHidden(chapter.metadata)) return reply.status(404).send({ error: 'Глава не найдена' });
    const geo = await countryBlocks(req);
    if (chapterBlocked(geo.index, geo.country, req.params.id, chapter.id)) return denyGeo(reply);
    const report = await prisma.readerReport.create({
      data: {
        projectId: req.params.id,
        chapterId: chapter.id,
        authorId: project.ownerId,
        quote: input.quote,
        note: input.note ?? '',
      },
    });
    await writeNotices(readerReportNotice({
      authorId: project.ownerId,
      reportId: report.id,
      bookTitle: project.name,
      quote: report.quote,
    }));
    return reply.status(201).send({ report });
  });
};

function publicBookComment(
  row: { id: string; authorName: string; body: string; chapterId: string; parentId: string; createdAt: Date },
  parentAuthorName: string,
) {
  return {
    id: row.id,
    authorName: row.authorName || 'Читатель',
    body: row.body,
    chapterId: row.chapterId,
    parentId: row.parentId,
    parentAuthorName: row.parentId ? parentAuthorName : '',
    createdAt: row.createdAt.toISOString(),
  };
}

async function commentParentNames(ids: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return new Map();
  const rows = await prisma.bookComment.findMany({
    where: { id: { in: unique } },
    select: { id: true, authorName: true },
  });
  return new Map(rows.map((row) => [row.id, row.authorName || 'Читатель']));
}

function aboutOf(settings: unknown): string {
  if (!settings || typeof settings !== 'object') return '';
  const root = settings as { about?: unknown; bio?: unknown };
  const value = typeof root.about === 'string' ? root.about : typeof root.bio === 'string' ? root.bio : '';
  return value.trim().slice(0, 2000);
}

function plainExcerpt(body: string): string {
  return body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 220);
}

function cyclesOf(books: BookCard[]): Array<{ name: string; books: BookCard[] }> {
  const groups = new Map<string, BookCard[]>();
  for (const book of books) {
    const name = book.cycle.trim();
    if (!name) continue;
    const list = groups.get(name) ?? [];
    list.push(book);
    groups.set(name, list);
  }
  return [...groups.entries()]
    .sort((a, b) => a[0].localeCompare(b[0], 'ru'))
    .map(([name, list]) => ({ name, books: inCycleOrder(list) }));
}

async function hideBooks(req: FastifyRequest, books: BookCard[]): Promise<BookCard[]> {
  const geo = await countryBlocks(req);
  if (!geo.country) return books;
  return books.filter((book) => !bookBlocked(geo.index, geo.country, book.id));
}

function metaPublished(settings: unknown): boolean {
  if (!settings || typeof settings !== 'object') return false;
  const catalog = (settings as { catalog?: { published?: unknown } }).catalog;
  return catalog?.published === true;
}

async function bookDigest(projectId: string, actorId: string, bucket: 'likes' | 'reading', on: boolean) {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { ownerId: true, name: true },
  });
  if (!project) return;
  await writeDigest({
    ownerId: project.ownerId,
    actorId,
    bucket,
    on,
    subject: project.name,
    href: `/books/${projectId}`,
    eventKey: bookDigestKey(projectId, digestDay(new Date())),
  });
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
