import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { coverHref } from './ai/place.js';
import { prisma } from './prisma.js';

export const positionSchema = z.object({
  chapterId: z.string().min(1).max(128),
  version: z.string().max(64),
  block: z.number().int().min(0).max(100_000).nullable(),
  offset: z.number().int().min(0).max(10_000),
  fraction: z.number().int().min(0).max(10_000),
  observedAt: z.number().int().nonnegative().safe(),
});

type PositionInput = z.infer<typeof positionSchema>;

export async function saveReadingPosition(userId: string, projectId: string, point: PositionInput) {
  const observedAt = new Date(Math.min(point.observedAt, Date.now()));
  await prisma.$executeRaw`
    INSERT INTO reading_positions ("userId", "projectId", "chapterId", version, block, "offset", fraction, "observedAt")
    VALUES (${userId}, ${projectId}, ${point.chapterId}, ${point.version}, ${point.block}, ${point.offset}, ${point.fraction}, ${observedAt})
    ON CONFLICT ("userId", "projectId") DO UPDATE SET
      "chapterId" = EXCLUDED."chapterId", version = EXCLUDED.version, block = EXCLUDED.block,
      "offset" = EXCLUDED."offset", fraction = EXCLUDED.fraction, "observedAt" = EXCLUDED."observedAt"
    WHERE reading_positions."observedAt" < EXCLUDED."observedAt"
  `;
}

export async function recentReadingPositions(
  userId: string,
  projectId: string | undefined,
  hidden: { books: string[]; chapters: string[]; authors: string[] },
) {
  type Row = Omit<PositionInput, 'observedAt'> & {
    projectId: string;
    title: string;
    chapterTitle: string;
    cover: unknown;
    observedAt: Date;
  };
  const book = projectId ? Prisma.sql`AND "projectId" = ${projectId}` : Prisma.empty;
  const positions = await prisma.$queryRaw<Row[]>`
    WITH saved AS (
      SELECT "projectId", "chapterId", version, block, "offset", fraction, "observedAt"
      FROM reading_positions WHERE "userId" = ${userId} ${book}
    ), previous_progress AS (
      SELECT DISTINCT ON (m."projectId") m."projectId", m."chapterId",
             ''::text AS version, NULL::int AS block, 0 AS "offset", m.percent * 100 AS fraction,
             m."updatedAt" AS "observedAt"
      FROM (SELECT * FROM read_progress WHERE "userId" = ${userId} ${book}) m
      WHERE NOT EXISTS (SELECT 1 FROM saved WHERE saved."projectId" = m."projectId")
      ORDER BY m."projectId", m."updatedAt" DESC, m."chapterId"
    ), positions AS (
      SELECT * FROM saved UNION ALL SELECT * FROM previous_progress
    )
    SELECT r."projectId", r."chapterId", r.version, r.block, r."offset", r.fraction, r."observedAt",
           p.name AS title, p.settings->'cover' AS cover, c.title AS "chapterTitle"
    FROM positions r
    JOIN projects p ON p.id = r."projectId"
    JOIN chapters c ON c.id = r."chapterId" AND c."projectId" = p.id
    WHERE p.settings #> '{catalog,published}' = 'true'::jsonb
      AND c.metadata->'public' IS DISTINCT FROM 'false'::jsonb
      AND NOT (p.id = ANY(${hidden.books}::text[]))
      AND NOT (p."ownerId" = ANY(${hidden.authors}::text[]))
      AND NOT (c.id = ANY(${hidden.chapters}::text[]))
    ORDER BY r."observedAt" DESC, r."projectId" LIMIT ${projectId ? 1 : 8}
  `;
  return positions.map(({ cover, observedAt, ...point }) => {
    const image = coverHref(cover);
    return { ...point, cover: image.length <= 2048 ? image : '', observedAt: observedAt.getTime() };
  });
}
