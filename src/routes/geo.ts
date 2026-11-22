import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import { prisma } from '../lib/prisma.js';
import { requireAdmin } from '../lib/accountStatus.js';
import { COUNTRIES, countryName } from '../lib/geo/countries.js';
import { countryList } from '../lib/geo/policy.js';
import { clearGeoCache } from '../lib/geo/request.js';

const KINDS = ['book', 'chapter', 'post'] as const;
type GeoKind = (typeof KINDS)[number];
const kindSchema = z.enum(KINDS);

export const geoAdminRoutes: FastifyPluginAsync = async (app) => {
  app.get('/api/admin/geo-countries', async (req, reply) => {
    if (!(await requireAdmin(app, req, reply))) return;
    return {
      countries: [...COUNTRIES].sort((a, b) => a.name.localeCompare(b.name, 'ru')),
    };
  });

  app.get('/api/admin/geo-blocks', async (req, reply) => {
    if (!(await requireAdmin(app, req, reply))) return;
    const rows = await prisma.geoBlock.findMany({ orderBy: { updatedAt: 'desc' } });
    const titles = await titlesOf(rows);
    return {
      blocks: rows.map((row) => {
        const known = titles.get(`${row.kind}:${row.targetId}`);
        return {
          id: row.id,
          kind: row.kind,
          targetId: row.targetId,
          title: known?.title ?? 'Материал удалён',
          hint: known?.hint ?? '',
          countries: row.countries,
          countryNames: row.countries.map((code) => countryName(code)),
          note: row.note,
          updatedAt: row.updatedAt.toISOString(),
        };
      }),
    };
  });

  app.get('/api/admin/geo-targets', async (req, reply) => {
    if (!(await requireAdmin(app, req, reply))) return;
    const query = z.object({
      kind: kindSchema,
      q: z.string().trim().max(80).optional(),
    }).parse(req.query);
    return { targets: await searchTargets(query.kind, query.q ?? '') };
  });

  app.put('/api/admin/geo-blocks', async (req, reply) => {
    if (!(await requireAdmin(app, req, reply))) return;
    const input = z.object({
      kind: kindSchema,
      targetId: z.string().trim().min(1).max(40),
      countries: z.array(z.string()).max(30),
      note: z.string().trim().max(500).optional(),
    }).parse(req.body);
    const countries = countryList(input.countries);
    if ('error' in countries) return reply.status(400).send({ error: countries.error });
    if (!(await targetExists(input.kind, input.targetId))) {
      return reply.status(404).send({ error: 'Материал не найден' });
    }
    const row = await prisma.geoBlock.upsert({
      where: { kind_targetId: { kind: input.kind, targetId: input.targetId } },
      create: {
        kind: input.kind,
        targetId: input.targetId,
        countries: countries.ok,
        note: input.note ?? '',
      },
      update: { countries: countries.ok, note: input.note ?? '' },
    });
    clearGeoCache();
    return { id: row.id };
  });

  app.delete<{ Params: { id: string } }>('/api/admin/geo-blocks/:id', async (req, reply) => {
    if (!(await requireAdmin(app, req, reply))) return;
    const row = await prisma.geoBlock.findUnique({ where: { id: req.params.id }, select: { id: true } });
    if (!row) return reply.status(404).send({ error: 'Ограничение не найдено' });
    await prisma.geoBlock.delete({ where: { id: row.id } });
    clearGeoCache();
    return { ok: true };
  });
};

async function targetExists(kind: GeoKind, id: string): Promise<boolean> {
  if (kind === 'book') {
    return Boolean(await prisma.project.findUnique({ where: { id }, select: { id: true } }));
  }
  if (kind === 'chapter') {
    return Boolean(await prisma.chapter.findUnique({ where: { id }, select: { id: true } }));
  }
  return Boolean(await prisma.blogPost.findUnique({ where: { id }, select: { id: true } }));
}

async function searchTargets(kind: GeoKind, q: string) {
  if (kind === 'book') {
    const rows = await prisma.project.findMany({
      where: q ? { name: { contains: q, mode: 'insensitive' } } : undefined,
      select: { id: true, name: true, owner: { select: { name: true } } },
      orderBy: { updatedAt: 'desc' },
      take: 20,
    });
    return rows.map((row) => ({ id: row.id, title: row.name, hint: row.owner.name?.trim() || 'Автор' }));
  }
  if (kind === 'chapter') {
    const rows = await prisma.chapter.findMany({
      where: q ? { title: { contains: q, mode: 'insensitive' } } : undefined,
      select: { id: true, title: true, project: { select: { name: true } } },
      orderBy: { updatedAt: 'desc' },
      take: 20,
    });
    return rows.map((row) => ({ id: row.id, title: row.title, hint: row.project.name }));
  }
  const rows = await prisma.blogPost.findMany({
    where: q ? { title: { contains: q, mode: 'insensitive' } } : undefined,
    select: { id: true, title: true, author: { select: { name: true } } },
    orderBy: { updatedAt: 'desc' },
    take: 20,
  });
  return rows.map((row) => ({ id: row.id, title: row.title, hint: row.author.name?.trim() || 'Автор' }));
}

async function titlesOf(rows: Array<{ kind: string; targetId: string }>) {
  const map = new Map<string, { title: string; hint: string }>();
  const books = rows.filter((row) => row.kind === 'book').map((row) => row.targetId);
  const chapters = rows.filter((row) => row.kind === 'chapter').map((row) => row.targetId);
  const posts = rows.filter((row) => row.kind === 'post').map((row) => row.targetId);
  const [bookRows, chapterRows, postRows] = await Promise.all([
    books.length
      ? prisma.project.findMany({
        where: { id: { in: books } },
        select: { id: true, name: true, owner: { select: { name: true } } },
      })
      : [],
    chapters.length
      ? prisma.chapter.findMany({
        where: { id: { in: chapters } },
        select: { id: true, title: true, project: { select: { name: true } } },
      })
      : [],
    posts.length
      ? prisma.blogPost.findMany({
        where: { id: { in: posts } },
        select: { id: true, title: true, author: { select: { name: true } } },
      })
      : [],
  ]);
  for (const row of bookRows) {
    map.set(`book:${row.id}`, { title: row.name, hint: row.owner.name?.trim() || 'Автор' });
  }
  for (const row of chapterRows) {
    map.set(`chapter:${row.id}`, { title: row.title, hint: row.project.name });
  }
  for (const row of postRows) {
    map.set(`post:${row.id}`, { title: row.title, hint: row.author.name?.trim() || 'Автор' });
  }
  return map;
}
