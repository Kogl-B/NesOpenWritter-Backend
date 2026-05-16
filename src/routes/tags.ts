import type { FastifyPluginAsync } from 'fastify';

import { prisma } from '../lib/prisma.js';
import { assertProjectOwnership } from '../lib/access.js';
import { tagCreateSchema, tagUpdateSchema, tagAssignSchema } from '../lib/schemas.js';

type ProjectParam = { projectId: string };
type TagParam = { projectId: string; tagId: string };
type EntityTagParam = {
  projectId: string;
  tagId: string;
  entityType: string;
  entityId: string;
};

// Resolve table for the polymorphic entityType to confirm it belongs to the project.
async function entityBelongsToProject(
  entityType: string,
  entityId: string,
  projectId: string,
): Promise<boolean> {
  switch (entityType) {
    case 'character': {
      const c = await prisma.character.findFirst({
        where: { id: entityId, projectId },
        select: { id: true },
      });
      return c !== null;
    }
    case 'item': {
      const i = await prisma.item.findFirst({
        where: { id: entityId, projectId },
        select: { id: true },
      });
      return i !== null;
    }
    case 'location': {
      const l = await prisma.location.findFirst({
        where: { id: entityId, projectId },
        select: { id: true },
      });
      return l !== null;
    }
    case 'event': {
      const e = await prisma.timelineEvent.findFirst({
        where: { id: entityId, projectId },
        select: { id: true },
      });
      return e !== null;
    }
    case 'chapter':
    case 'scene': {
      const ch = await prisma.chapter.findFirst({
        where: { id: entityId, projectId },
        select: { id: true },
      });
      return ch !== null;
    }
    default:
      return false;
  }
}

export const tagRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', async (req) => {
    app.requireAuth(req);
  });

  app.get<{ Params: ProjectParam }>(
    '/api/projects/:projectId/tags',
    async (req, reply) => {
      if (!(await assertProjectOwnership(req.params.projectId, req.user!.id))) {
        return reply.status(404).send({ error: 'Project not found' });
      }
      const tags = await prisma.tag.findMany({
        where: { projectId: req.params.projectId },
        orderBy: { name: 'asc' },
      });
      return { tags };
    },
  );

  app.post<{ Params: ProjectParam }>(
    '/api/projects/:projectId/tags',
    async (req, reply) => {
      if (!(await assertProjectOwnership(req.params.projectId, req.user!.id))) {
        return reply.status(404).send({ error: 'Project not found' });
      }
      const input = tagCreateSchema.parse(req.body);
      try {
        const tag = await prisma.tag.create({
          data: {
            projectId: req.params.projectId,
            name: input.name,
            color: input.color ?? '#888888',
            description: input.description ?? null,
          },
        });
        return reply.status(201).send({ tag });
      } catch (e) {
        if ((e as { code?: string }).code === 'P2002') {
          return reply.status(409).send({ error: 'Tag with this name exists' });
        }
        throw e;
      }
    },
  );

  app.patch<{ Params: TagParam }>(
    '/api/projects/:projectId/tags/:tagId',
    async (req, reply) => {
      if (!(await assertProjectOwnership(req.params.projectId, req.user!.id))) {
        return reply.status(404).send({ error: 'Project not found' });
      }
      const input = tagUpdateSchema.parse(req.body);
      const result = await prisma.tag.updateMany({
        where: { id: req.params.tagId, projectId: req.params.projectId },
        data: {
          ...(input.name !== undefined && { name: input.name }),
          ...(input.color !== undefined && { color: input.color }),
          ...(input.description !== undefined && { description: input.description }),
        },
      });
      if (result.count === 0) return reply.status(404).send({ error: 'Tag not found' });
      const tag = await prisma.tag.findUnique({ where: { id: req.params.tagId } });
      return { tag };
    },
  );

  app.delete<{ Params: TagParam }>(
    '/api/projects/:projectId/tags/:tagId',
    async (req, reply) => {
      if (!(await assertProjectOwnership(req.params.projectId, req.user!.id))) {
        return reply.status(404).send({ error: 'Project not found' });
      }
      const result = await prisma.tag.deleteMany({
        where: { id: req.params.tagId, projectId: req.params.projectId },
      });
      if (result.count === 0) return reply.status(404).send({ error: 'Tag not found' });
      return reply.status(204).send();
    },
  );

  // ----- Tag assignments to polymorphic entities --------------------------

  app.post<{ Params: TagParam }>(
    '/api/projects/:projectId/tags/:tagId/assign',
    async (req, reply) => {
      if (!(await assertProjectOwnership(req.params.projectId, req.user!.id))) {
        return reply.status(404).send({ error: 'Project not found' });
      }
      const tag = await prisma.tag.findFirst({
        where: { id: req.params.tagId, projectId: req.params.projectId },
        select: { id: true },
      });
      if (!tag) return reply.status(404).send({ error: 'Tag not found' });
      const input = tagAssignSchema.parse(req.body);
      const ok = await entityBelongsToProject(
        input.entityType,
        input.entityId,
        req.params.projectId,
      );
      if (!ok) return reply.status(400).send({ error: 'Entity not in project' });
      const link = await prisma.entityTag.upsert({
        where: {
          tagId_entityType_entityId: {
            tagId: req.params.tagId,
            entityType: input.entityType,
            entityId: input.entityId,
          },
        },
        update: {},
        create: {
          tagId: req.params.tagId,
          entityType: input.entityType,
          entityId: input.entityId,
        },
      });
      return reply.status(201).send({ link });
    },
  );

  app.delete<{ Params: EntityTagParam }>(
    '/api/projects/:projectId/tags/:tagId/assign/:entityType/:entityId',
    async (req, reply) => {
      if (!(await assertProjectOwnership(req.params.projectId, req.user!.id))) {
        return reply.status(404).send({ error: 'Project not found' });
      }
      try {
        await prisma.entityTag.delete({
          where: {
            tagId_entityType_entityId: {
              tagId: req.params.tagId,
              entityType: req.params.entityType,
              entityId: req.params.entityId,
            },
          },
        });
        return reply.status(204).send();
      } catch {
        return reply.status(404).send({ error: 'Assignment not found' });
      }
    },
  );

  // List all tag links for an entity (e.g. character page sidebar)
  app.get<{ Params: { projectId: string; entityType: string; entityId: string } }>(
    '/api/projects/:projectId/tag-links/:entityType/:entityId',
    async (req, reply) => {
      if (!(await assertProjectOwnership(req.params.projectId, req.user!.id))) {
        return reply.status(404).send({ error: 'Project not found' });
      }
      const links = await prisma.entityTag.findMany({
        where: {
          entityType: req.params.entityType,
          entityId: req.params.entityId,
          tag: { projectId: req.params.projectId },
        },
        include: { tag: true },
      });
      return { links };
    },
  );
};
