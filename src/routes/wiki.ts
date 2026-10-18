import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { assertProjectOwnership, getProjectAccess } from '../lib/access.js';

const wikiCreateSchema = z.object({
  title: z.string().trim().min(1).max(200),
  content: z.string().max(100_000),
  category: z.string().max(100).optional().nullable(),
  tags: z.array(z.string().max(50)).max(20).optional(),
});

const wikiUpdateSchema = wikiCreateSchema.partial();

/**
 * v1.2 — Вики проекта: связанные статьи с категориями и внутренними ссылками.
 * Slug генерируется из title автоматически.
 */
const ROLE_RANK = ['owner', 'admin', 'editor', 'viewer'] as const;

async function authorById(projectId: string, ids: Array<string | null | undefined>) {
  const unique = [...new Set(ids.filter((id): id is string => !!id))];
  const empty = new Map<string, { id: string; name: string; role: string }>();
  if (unique.length === 0) return empty;
  const [project, users, collabs] = await Promise.all([
    prisma.project.findUnique({ where: { id: projectId }, select: { ownerId: true } }),
    prisma.user.findMany({
      where: { id: { in: unique } },
      select: { id: true, name: true, email: true },
    }),
    prisma.projectCollaborator.findMany({
      where: { projectId, userId: { in: unique }, status: 'active' },
      select: { userId: true, role: true },
    }),
  ]);
  const collabRole = new Map(collabs.map((c) => [c.userId, c.role]));
  for (const user of users) {
    const role = user.id === project?.ownerId
      ? 'owner'
      : (collabRole.get(user.id) ?? 'editor');
    empty.set(user.id, {
      id: user.id,
      name: user.name?.trim() || user.email,
      role: (ROLE_RANK as readonly string[]).includes(role) ? role : 'editor',
    });
  }
  return empty;
}

function withAuthor<T extends { createdById: string | null }>(
  page: T,
  authors: Map<string, { id: string; name: string; role: string }>,
) {
  return { ...page, author: page.createdById ? authors.get(page.createdById) ?? null : null };
}

function slugify(title: string): string {
  const map: Record<string, string> = {
    а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z',
    и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r',
    с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch',
    ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
  };
  return title
    .toLowerCase()
    .split('')
    .map((c) => map[c] ?? c)
    .join('')
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 100) || 'untitled';
}

export async function wikiRoutes(app: FastifyInstance) {
  app.get<{ Params: { projectId: string } }>(
    '/api/projects/:projectId/wiki',
    async (req, reply) => {
      app.requireAuth(req);
      if (!(await assertProjectOwnership(req.params.projectId, req.user!.id))) {
        return reply.status(404).send({ error: 'Project not found' });
      }
      const pages = await prisma.wikiPage.findMany({
        where: { projectId: req.params.projectId },
        select: {
          id: true, slug: true, title: true, category: true,
          tags: true, createdById: true, createdAt: true, updatedAt: true,
        },
        orderBy: [{ category: 'asc' }, { title: 'asc' }],
      });
      const authors = await authorById(req.params.projectId, pages.map((p) => p.createdById));
      return { pages: pages.map((p) => withAuthor(p, authors)) };
    },
  );

  app.get<{ Params: { projectId: string; slug: string } }>(
    '/api/projects/:projectId/wiki/:slug',
    async (req, reply) => {
      app.requireAuth(req);
      if (!(await assertProjectOwnership(req.params.projectId, req.user!.id))) {
        return reply.status(404).send({ error: 'Project not found' });
      }
      const page = await prisma.wikiPage.findFirst({
        where: {
          projectId: req.params.projectId,
          slug: req.params.slug,
        },
      });
      if (!page) return reply.status(404).send({ error: 'Page not found' });
      const authors = await authorById(req.params.projectId, [page.createdById]);
      return { page: withAuthor(page, authors) };
    },
  );

  app.post<{ Params: { projectId: string } }>(
    '/api/projects/:projectId/wiki',
    async (req, reply) => {
      app.requireAuth(req);
      const role = await getProjectAccess(req.params.projectId, req.user!.id);
      if (!role) return reply.status(404).send({ error: 'Project not found' });
      if (role === 'viewer') return reply.status(403).send({ error: 'Читатель не может править вики' });
      const input = wikiCreateSchema.parse(req.body);
      let slug = slugify(input.title);
      // Ensure unique slug within project
      const existing = await prisma.wikiPage.findFirst({
        where: { projectId: req.params.projectId, slug },
        select: { id: true },
      });
      if (existing) slug = `${slug}-${Date.now().toString(36)}`;
      let page;
      try {
        page = await prisma.wikiPage.create({
          data: {
            projectId: req.params.projectId,
            slug,
            title: input.title,
            content: input.content,
            category: input.category ?? null,
            tags: input.tags ?? [],
            createdById: req.user!.id,
          },
        });
      } catch (err) {
        // Гонка двух одинаковых POST: второй findFirst ещё не видел первой записи
        if ((err as { code?: string }).code === 'P2002') {
          slug = `${slug}-${Date.now().toString(36)}`;
          page = await prisma.wikiPage.create({
            data: {
              projectId: req.params.projectId,
              slug,
              title: input.title,
              content: input.content,
              category: input.category ?? null,
              tags: input.tags ?? [],
              createdById: req.user!.id,
            },
          });
        } else {
          throw err;
        }
      }
      return reply.status(201).send({ page });
    },
  );

  app.patch<{ Params: { projectId: string; slug: string } }>(
    '/api/projects/:projectId/wiki/:slug',
    async (req, reply) => {
      app.requireAuth(req);
      const role = await getProjectAccess(req.params.projectId, req.user!.id);
      if (!role) return reply.status(404).send({ error: 'Project not found' });
      if (role === 'viewer') return reply.status(403).send({ error: 'Читатель не может править вики' });
      const input = wikiUpdateSchema.parse(req.body);
      try {
        const updated = await prisma.wikiPage.update({
          where: {
            projectId_slug: {
              projectId: req.params.projectId,
              slug: req.params.slug,
            },
          },
          data: {
            ...(input.title !== undefined && { title: input.title }),
            ...(input.content !== undefined && { content: input.content }),
            ...(input.category !== undefined && { category: input.category }),
            ...(input.tags !== undefined && { tags: input.tags }),
          },
        });
        const authors = await authorById(req.params.projectId, [updated.createdById]);
        return { page: withAuthor(updated, authors) };
      } catch {
        return reply.status(404).send({ error: 'Page not found' });
      }
    },
  );

  app.delete<{ Params: { projectId: string; slug: string } }>(
    '/api/projects/:projectId/wiki/:slug',
    async (req, reply) => {
      app.requireAuth(req);
      const role = await getProjectAccess(req.params.projectId, req.user!.id);
      if (!role) return reply.status(404).send({ error: 'Project not found' });
      if (role === 'viewer') return reply.status(403).send({ error: 'Читатель не может править вики' });
      try {
        await prisma.wikiPage.delete({
          where: {
            projectId_slug: {
              projectId: req.params.projectId,
              slug: req.params.slug,
            },
          },
        });
        return reply.status(204).send();
      } catch {
        return reply.status(404).send({ error: 'Page not found' });
      }
    },
  );
}
