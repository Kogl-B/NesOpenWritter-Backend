import { Prisma } from '@prisma/client';

import { catalogFilters, PAGE_WORDS, type CatalogQuery } from './catalogSearch.js';
import { expandGenre, flattenGenres } from './genres.js';
import { prisma } from './prisma.js';

export interface CatalogVisibility {
  userId: string | null;
  excludedBooks: string[];
  excludedAuthors: string[];
}

const DAY = 86_400_000;
const PAGE_SIZE = 48;
const GENRE_NAMES = JSON.stringify(Object.fromEntries(flattenGenres().map(({ id, name }) => [id, name])));
const visible = Prisma.sql`COALESCE(p.settings #>> '{catalog,published}', '') = 'true'`;

function and(conditions: Prisma.Sql[]) {
  return conditions.length ? Prisma.sql`AND ${Prisma.join(conditions, ' AND ')}` : Prisma.empty;
}

function strings(column: Prisma.Sql) {
  return Prisma.sql`ARRAY(
    SELECT entry #>> '{}'
    FROM jsonb_array_elements(CASE jsonb_typeof(${column}) WHEN 'array' THEN ${column} ELSE '[]'::jsonb END) AS elements(entry)
    WHERE jsonb_typeof(entry) = 'string'
  )`;
}

function searchScope(query: CatalogQuery, now: number) {
  const f = catalogFilters(query, expandGenre, now);
  const fields: Prisma.Sql[] = [];
  const measured: Prisma.Sql[] = [];
  if (f.allowed) fields.push(Prisma.sql`b.genres && ${[...f.allowed]}::text[]`);
  if (f.statuses.length) fields.push(Prisma.sql`b.status = ANY(${f.statuses}::text[])`);
  if (f.author) fields.push(Prisma.sql`strpos(lower(b."authorName"), ${f.author}) > 0`);
  if (f.cycle) fields.push(Prisma.sql`strpos(lower(b.cycle), ${f.cycle}) > 0`);
  const mentions = (part: string) => Prisma.sql`EXISTS (
    SELECT 1 FROM unnest(b.tags || n."genreNames") AS names(value)
    WHERE strpos(lower(value), ${part}) > 0
  )`;
  for (const part of f.tags) fields.push(mentions(part));
  for (const part of f.excluded) fields.push(Prisma.sql`NOT ${mentions(part)}`);
  if (f.q) {
    fields.push(Prisma.sql`strpos(lower(concat_ws(' ', b.name, b."authorName", b.description, b.cycle,
      array_to_string(b.tags, ' '), array_to_string(n."genreNames", ' '))), ${f.q}) > 0`);
  }

  if (f.pages) {
    const pages = Prisma.sql`ceil(greatest(COALESCE(c.words, 0), 0)::numeric / ${PAGE_WORDS})`;
    measured.push(Prisma.sql`${pages} >= ${f.pages.min}`);
    if (Number.isFinite(f.pages.max)) measured.push(Prisma.sql`${pages} <= ${f.pages.max}`);
  }
  if (f.minWords) measured.push(Prisma.sql`COALESCE(c.words, 0) >= ${f.minWords}`);
  if (f.maxWords) measured.push(Prisma.sql`COALESCE(c.words, 0) <= ${f.maxWords}`);
  if (f.freshAfter !== null) {
    // Keep extremely broad legacy date filters within PostgreSQL's timestamp range.
    measured.push(Prisma.sql`COALESCE(c."textUpdatedAt", b."updatedAt") >= ${new Date(Math.max(Date.UTC(1_000, 0, 1), f.freshAfter))}`);
  }

  const needsText = Boolean(f.q || f.author || f.cycle || f.allowed || f.statuses.length || f.tags.length || f.excluded.length);
  return {
    measured,
    candidates: needsText ? Prisma.sql`
      SELECT b.id, b."ownerId", b."authorName", b."createdAt", b."updatedAt" FROM (
        SELECT v.*,
          CASE WHEN jsonb_typeof(v.settings #> '{catalog,cycle}') = 'string'
            THEN v.settings #>> '{catalog,cycle}' ELSE '' END AS cycle,
          CASE WHEN v.settings #>> '{catalog,status}' IN ('complete', 'frozen')
            THEN v.settings #>> '{catalog,status}' ELSE 'writing' END AS status,
          ${strings(Prisma.sql`v.settings #> '{catalog,tags}'`)} AS tags,
          ${strings(Prisma.sql`v.settings #> '{catalog,genres}'`)} AS genres
        FROM visible_books v
      ) b
      CROSS JOIN LATERAL (
        SELECT ARRAY(SELECT COALESCE(${GENRE_NAMES}::jsonb ->> id, id) FROM unnest(b.genres) AS genre(id)) AS "genreNames"
      ) n
      WHERE true ${and(fields)}
    ` : Prisma.sql`SELECT id, "ownerId", "authorName", "createdAt", "updatedAt" FROM visible_books`,
  };
}

function browse(scope: CatalogVisibility, now: number, query: CatalogQuery = {}) {
  const filters = searchScope(query, now);
  return Prisma.sql`
    WITH visible_books AS (
      SELECT p.id, p."ownerId", p.name, COALESCE(p.description, '') AS description, p.settings,
             COALESCE(NULLIF(btrim(u.name), ''), 'Автор') AS "authorName", p."createdAt", p."updatedAt"
      FROM projects p JOIN users u ON u.id = p."ownerId"
      WHERE ${visible} AND NOT (p.id = ANY(${scope.excludedBooks}::text[]))
        AND NOT (p."ownerId" = ANY(${scope.excludedAuthors}::text[]))
    ), candidates AS (
      ${filters.candidates}
    ), chapters_counted AS MATERIALIZED (
      SELECT b.*, COALESCE(c.words, 0)::int AS words, COALESCE(c."textUpdatedAt", b."updatedAt") AS "textUpdatedAt"
      FROM candidates b LEFT JOIN LATERAL (
        SELECT SUM(c."wordCount") AS words, MAX(c."updatedAt") AS "textUpdatedAt"
        FROM chapters c WHERE c."projectId" = b.id AND COALESCE(c.metadata->>'public', '') <> 'false'
      ) c ON true
      WHERE true ${and(filters.measured)}
    ), ranked AS MATERIALIZED (
      SELECT b.*, v.views, r.likes, r.favorites, r."readingNow", COALESCE(mine.favorite, false) AS "myFavorite"
      FROM chapters_counted b
      LEFT JOIN LATERAL (
        SELECT count(*)::int AS views FROM book_views WHERE "projectId" = b.id
      ) v ON true
      LEFT JOIN LATERAL (
        SELECT count(*) FILTER (WHERE liked)::int AS likes,
               count(*) FILTER (WHERE favorite)::int AS favorites,
               count(*) FILTER (WHERE "lastReadAt" >= ${new Date(now - 14 * DAY)})::int AS "readingNow"
        FROM book_reactions WHERE "projectId" = b.id
      ) r ON true
      LEFT JOIN book_reactions mine ON mine."projectId" = b.id AND mine."userId" = ${scope.userId}
    )
  `;
}

const SEARCH_ORDER: Record<string, Prisma.Sql> = {
  new: Prisma.sql`"createdAt" DESC`,
  updated: Prisma.sql`"textUpdatedAt" DESC`,
  likes: Prisma.sql`likes DESC, views DESC`,
  words: Prisma.sql`words DESC`,
  favorites: Prisma.sql`favorites DESC, likes DESC`,
};
const POPULAR_ORDER = Prisma.sql`views DESC, likes DESC, words DESC`;

export async function searchCatalog(scope: CatalogVisibility, query: CatalogQuery, page: number, now: number) {
  const order = Object.hasOwn(SEARCH_ORDER, query.sort ?? '') ? SEARCH_ORDER[query.sort!]! : POPULAR_ORDER;
  const [row] = await prisma.$queryRaw<Array<{ ids: string[]; total: number }>>`
    ${browse(scope, now, query)}
    SELECT (SELECT count(*)::int FROM chapters_counted) AS total,
      ARRAY(SELECT id FROM ranked ORDER BY ${order}, id LIMIT ${PAGE_SIZE} OFFSET ${(page - 1) * PAGE_SIZE}) AS ids
  `;
  return { ids: row!.ids, total: row!.total, page, pageSize: PAGE_SIZE };
}

export type HomeShelf = 'popular' | 'hot' | 'updates' | 'bestsellers' | 'arrivals' | 'reading' | 'liked' | 'favorites';
type HomeIds = Record<HomeShelf | 'recommended', string[]>;

export async function homeCatalog(scope: CatalogVisibility, now: number): Promise<HomeIds> {
  const recent = new Date(now - 90 * DAY);
  const [row] = await prisma.$queryRaw<HomeIds[]>`
    ${browse(scope, now)}
    SELECT
      ARRAY(SELECT id FROM ranked WHERE likes + favorites > 0
        ORDER BY (likes + favorites)::double precision / (views + 20) DESC, likes DESC, views DESC, id LIMIT 12) AS recommended,
      ARRAY(SELECT id FROM ranked ORDER BY views DESC, words DESC, id LIMIT 12) AS popular,
      ARRAY(SELECT id FROM ranked WHERE "createdAt" > ${recent} OR NOT EXISTS (
        SELECT 1 FROM ranked WHERE "createdAt" > ${recent}
      ) ORDER BY views DESC, "createdAt" DESC, id LIMIT 12) AS hot,
      ARRAY(SELECT id FROM ranked ORDER BY "textUpdatedAt" DESC, id LIMIT 12) AS updates,
      ARRAY(SELECT id FROM ranked ORDER BY likes DESC, views DESC, words DESC, id LIMIT 12) AS bestsellers,
      ARRAY(SELECT id FROM ranked ORDER BY "createdAt" DESC, id LIMIT 12) AS arrivals,
      ARRAY(SELECT id FROM ranked ORDER BY "readingNow" DESC, "textUpdatedAt" DESC, id LIMIT 12) AS reading,
      ARRAY(SELECT id FROM ranked ORDER BY likes DESC, favorites DESC, id LIMIT 12) AS liked,
      ARRAY(SELECT id FROM ranked WHERE "myFavorite" OR NOT EXISTS (
        SELECT 1 FROM ranked WHERE "myFavorite"
      ) ORDER BY CASE WHEN "myFavorite" THEN 0 ELSE favorites END DESC,
        CASE WHEN "myFavorite" THEN 0 ELSE likes END DESC, id LIMIT 12) AS favorites
  `;
  return row!;
}

type AuthorRank = { id: string; name: string; books: number; words: number; likes: number; views: number };

export async function topCatalog(scope: CatalogVisibility, now: number) {
  const [row] = await prisma.$queryRaw<Array<{ authors: AuthorRank[]; byLikes: string[]; byViews: string[] }>>`
    ${browse(scope, now)}
    SELECT ARRAY(SELECT id FROM ranked ORDER BY likes DESC, views DESC, words DESC, id LIMIT 30) AS "byLikes",
      ARRAY(SELECT id FROM ranked ORDER BY views DESC, likes DESC, words DESC, id LIMIT 30) AS "byViews",
      COALESCE((
        SELECT jsonb_agg(a ORDER BY likes DESC, views DESC, words DESC, id) FROM (
          SELECT "ownerId" AS id, "authorName" AS name, count(*)::int AS books,
                 sum(words) AS words, sum(likes) AS likes, sum(views) AS views
          FROM ranked GROUP BY "ownerId", "authorName"
          ORDER BY likes DESC, views DESC, words DESC, id LIMIT 30
        ) a
      ), '[]'::jsonb) AS authors
  `;
  return row!;
}
