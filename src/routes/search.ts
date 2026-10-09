import type { FastifyPluginAsync } from 'fastify';

import { Prisma } from '@prisma/client';

import { prisma } from '../lib/prisma.js';
import { assertProjectOwnership } from '../lib/access.js';
import { searchQuerySchema } from '../lib/schemas.js';

type ProjectParam = { projectId: string };

interface SearchHit {
  entityType: 'character' | 'item' | 'location' | 'event' | 'chapter' | 'tag';
  id: string;
  name: string;
  preview: string | null;
}

const ALL_TYPES = ['character', 'item', 'location', 'event', 'chapter', 'tag'] as const;

export const searchRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', async (req) => {
    app.requireAuth(req);
  });

  app.get<{
    Params: ProjectParam;
    Querystring: { q?: string; types?: string; limit?: string };
  }>('/api/projects/:projectId/search', async (req, reply) => {
    if (!(await assertProjectOwnership(req.params.projectId, req.user!.id))) {
      return reply.status(404).send({ error: 'Project not found' });
    }
    const parsed = searchQuerySchema.parse(req.query);
    const q = parsed.q;
    const limit = parsed.limit;
    const types = (parsed.types?.length
      ? parsed.types
      : (ALL_TYPES as readonly string[])) as readonly string[];

    // Один UNION ALL вместо шести параллельных findMany: шесть хопов через
    // движок Prisma (~5-17ms каждый на материализации) сжимаются в один,
    // seq-scan'ы таблиц идут параллельно внутри самого Postgres. Порядок
    // веток сохраняется ординалом — фронт группирует результаты по типам
    // в порядке declared above (total считается до среза, как раньше).
    const P = req.params.projectId;
    const like = `%${q}%`;
    const branches: Array<{ ordinal: number; sql: Prisma.Sql }> = [];
    let ordinal = 0;
    if (types.includes('character')) {
      // OR-фильтр по четырём колонкам плановик исполняет seq-фильтром по
      // всем строкам проекта (~28ms на 454 строках из-за ILIKE-эвалов).
      // IN (UNION ...) заставляет каждую колонку идти своим trigram-индексом
      // (см. миграцию 20261009150000_search_trgm_characters) — ~6ms.
      branches.push({
        ordinal: ordinal++,
        sql: Prisma.sql`
          SELECT ${ordinal}::int AS ord, 'character'::text AS "entityType", id, name, summary AS preview
          FROM characters
          WHERE "projectId" = ${P} AND id IN (
            SELECT id FROM characters WHERE "projectId" = ${P} AND name ILIKE ${like}
            UNION SELECT id FROM characters WHERE "projectId" = ${P} AND "shortName" ILIKE ${like}
            UNION SELECT id FROM characters WHERE "projectId" = ${P} AND summary ILIKE ${like}
            UNION SELECT id FROM characters WHERE "projectId" = ${P} AND biography ILIKE ${like}
          )
          LIMIT ${limit}`,
      });
    }
    if (types.includes('item')) {
      branches.push({
        ordinal: ordinal++,
        sql: Prisma.sql`
          SELECT ${ordinal}::int AS ord, 'item'::text AS "entityType", id, name, summary AS preview
          FROM items
          WHERE "projectId" = ${P} AND (name ILIKE ${like} OR summary ILIKE ${like}
            OR description ILIKE ${like})
          LIMIT ${limit}`,
      });
    }
    if (types.includes('location')) {
      branches.push({
        ordinal: ordinal++,
        sql: Prisma.sql`
          SELECT ${ordinal}::int AS ord, 'location'::text AS "entityType", id, name, description AS preview
          FROM locations
          WHERE "projectId" = ${P} AND (name ILIKE ${like} OR "shortName" ILIKE ${like}
            OR description ILIKE ${like})
          LIMIT ${limit}`,
      });
    }
    if (types.includes('event')) {
      branches.push({
        ordinal: ordinal++,
        sql: Prisma.sql`
          SELECT ${ordinal}::int AS ord, 'event'::text AS "entityType", id, name, summary AS preview
          FROM timeline_events
          WHERE "projectId" = ${P} AND (name ILIKE ${like} OR summary ILIKE ${like}
            OR description ILIKE ${like})
          LIMIT ${limit}`,
      });
    }
    if (types.includes('chapter')) {
      branches.push({
        ordinal: ordinal++,
        sql: Prisma.sql`
          SELECT ${ordinal}::int AS ord, 'chapter'::text AS "entityType", id, title AS name, summary AS preview
          FROM chapters
          WHERE "projectId" = ${P} AND (title ILIKE ${like} OR summary ILIKE ${like})
          LIMIT ${limit}`,
      });
    }
    if (types.includes('tag')) {
      branches.push({
        ordinal: ordinal++,
        sql: Prisma.sql`
          SELECT ${ordinal}::int AS ord, 'tag'::text AS "entityType", id, name, description AS preview
          FROM tags
          WHERE "projectId" = ${P} AND (name ILIKE ${like} OR description ILIKE ${like})
          LIMIT ${limit}`,
      });
    }

    if (branches.length === 0) {
      return { q, results: [], total: 0 };
    }

    const parts = branches.map((b) => b.sql);
    const query = Prisma.join(
      parts.map((p) => Prisma.sql`(${p})`),
      ' UNION ALL ',
    );
    const rows = await prisma.$queryRaw<
      Array<{ ord: number; entityType: SearchHit['entityType']; id: string; name: string; preview: string | null }>
    >(Prisma.sql`SELECT * FROM (${query}) AS u ORDER BY ord`);

    const hits: SearchHit[] = rows.map((r) => ({
      entityType: r.entityType,
      id: r.id,
      name: r.name,
      preview: r.preview,
    }));
    return { q, results: hits.slice(0, limit), total: hits.length };
  });
};
