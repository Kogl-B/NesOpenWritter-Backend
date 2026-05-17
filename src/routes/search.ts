import type { FastifyPluginAsync } from 'fastify';

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

    const ic = { mode: 'insensitive' as const };
    const hits: SearchHit[] = [];

    if (types.includes('character')) {
      const chars = await prisma.character.findMany({
        where: {
          projectId: req.params.projectId,
          OR: [
            { name: { contains: q, ...ic } },
            { shortName: { contains: q, ...ic } },
            { summary: { contains: q, ...ic } },
            { biography: { contains: q, ...ic } },
          ],
        },
        take: limit,
        select: { id: true, name: true, summary: true },
      });
      for (const c of chars)
        hits.push({ entityType: 'character', id: c.id, name: c.name, preview: c.summary });
    }

    if (types.includes('item')) {
      const items = await prisma.item.findMany({
        where: {
          projectId: req.params.projectId,
          OR: [
            { name: { contains: q, ...ic } },
            { summary: { contains: q, ...ic } },
            { description: { contains: q, ...ic } },
          ],
        },
        take: limit,
        select: { id: true, name: true, summary: true },
      });
      for (const i of items)
        hits.push({ entityType: 'item', id: i.id, name: i.name, preview: i.summary });
    }

    if (types.includes('location')) {
      const locations = await prisma.location.findMany({
        where: {
          projectId: req.params.projectId,
          OR: [
            { name: { contains: q, ...ic } },
            { shortName: { contains: q, ...ic } },
            { description: { contains: q, ...ic } },
          ],
        },
        take: limit,
        select: { id: true, name: true, description: true },
      });
      for (const l of locations)
        hits.push({
          entityType: 'location',
          id: l.id,
          name: l.name,
          preview: l.description,
        });
    }

    if (types.includes('event')) {
      const events = await prisma.timelineEvent.findMany({
        where: {
          projectId: req.params.projectId,
          OR: [
            { name: { contains: q, ...ic } },
            { summary: { contains: q, ...ic } },
            { description: { contains: q, ...ic } },
          ],
        },
        take: limit,
        select: { id: true, name: true, summary: true },
      });
      for (const e of events)
        hits.push({ entityType: 'event', id: e.id, name: e.name, preview: e.summary });
    }

    if (types.includes('chapter')) {
      const chapters = await prisma.chapter.findMany({
        where: {
          projectId: req.params.projectId,
          OR: [
            { title: { contains: q, ...ic } },
            { summary: { contains: q, ...ic } },
          ],
        },
        take: limit,
        select: { id: true, title: true, summary: true },
      });
      for (const ch of chapters)
        hits.push({
          entityType: 'chapter',
          id: ch.id,
          name: ch.title,
          preview: ch.summary,
        });
    }

    if (types.includes('tag')) {
      const tags = await prisma.tag.findMany({
        where: {
          projectId: req.params.projectId,
          OR: [
            { name: { contains: q, ...ic } },
            { description: { contains: q, ...ic } },
          ],
        },
        take: limit,
        select: { id: true, name: true, description: true },
      });
      for (const t of tags)
        hits.push({ entityType: 'tag', id: t.id, name: t.name, preview: t.description });
    }

    return { q, results: hits.slice(0, limit), total: hits.length };
  });
};
