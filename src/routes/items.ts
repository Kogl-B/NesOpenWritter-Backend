import type { FastifyPluginAsync } from 'fastify';

import { prisma } from '../lib/prisma.js';
import { assertProjectOwnership, toJson } from '../lib/access.js';
import {
  itemCreateSchema,
  itemUpdateSchema,
  itemTimelinePointCreateSchema,
  itemTimelinePointUpdateSchema,
} from '../lib/schemas.js';

type ProjectParam = { projectId: string };
type ItemParam = { projectId: string; itemId: string };
type TimelinePointParam = { projectId: string; itemId: string; pointId: string };

export const itemRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', async (req) => {
    app.requireAuth(req);
  });

  app.get<{ Params: ProjectParam }>(
    '/api/projects/:projectId/items',
    async (req, reply) => {
      if (!(await assertProjectOwnership(req.params.projectId, req.user!.id))) {
        return reply.status(404).send({ error: 'Project not found' });
      }
      const items = await prisma.item.findMany({
        where: { projectId: req.params.projectId },
        // Списку карточек достаточно метаданных; summary/description
        // приходят fetchOne при выборе предмета.
        select: {
          id: true, projectId: true, name: true, category: true, rarity: true,
          currentOwnerId: true, currentLocationId: true,
          imagePath: true,
          createdAt: true, updatedAt: true,
        },
        orderBy: { updatedAt: 'desc' },
      });
      return { items };
    },
  );

  app.post<{ Params: ProjectParam }>(
    '/api/projects/:projectId/items',
    async (req, reply) => {
      if (!(await assertProjectOwnership(req.params.projectId, req.user!.id))) {
        return reply.status(404).send({ error: 'Project not found' });
      }
      const input = itemCreateSchema.parse(req.body);
      const item = await prisma.item.create({
        data: {
          projectId: req.params.projectId,
          name: input.name,
          shortName: input.shortName ?? null,
          imagePath: input.imagePath ?? null,
          category: input.category ?? 'other',
          rarity: input.rarity ?? 'common',
          summary: input.summary ?? null,
          description: input.description ?? null,
          properties: toJson(input.properties),
          currentOwnerId: input.currentOwnerId ?? null,
          currentLocationId: input.currentLocationId ?? null,
          metadata: toJson(input.metadata),
        },
      });
      return reply.status(201).send({ item });
    },
  );

  app.get<{ Params: ItemParam }>(
    '/api/projects/:projectId/items/:itemId',
    async (req, reply) => {
      if (!(await assertProjectOwnership(req.params.projectId, req.user!.id))) {
        return reply.status(404).send({ error: 'Project not found' });
      }
      const item = await prisma.item.findFirst({
        where: { id: req.params.itemId, projectId: req.params.projectId },
      });
      if (!item) return reply.status(404).send({ error: 'Item not found' });
      return { item };
    },
  );

  app.patch<{ Params: ItemParam }>(
    '/api/projects/:projectId/items/:itemId',
    async (req, reply) => {
      if (!(await assertProjectOwnership(req.params.projectId, req.user!.id))) {
        return reply.status(404).send({ error: 'Project not found' });
      }
      const input = itemUpdateSchema.parse(req.body);
      const result = await prisma.item.updateMany({
        where: { id: req.params.itemId, projectId: req.params.projectId },
        data: {
          ...(input.name !== undefined && { name: input.name }),
          ...(input.shortName !== undefined && { shortName: input.shortName }),
          ...(input.imagePath !== undefined && { imagePath: input.imagePath }),
          ...(input.category !== undefined && { category: input.category }),
          ...(input.rarity !== undefined && { rarity: input.rarity }),
          ...(input.summary !== undefined && { summary: input.summary }),
          ...(input.description !== undefined && { description: input.description }),
          ...(input.properties !== undefined && { properties: toJson(input.properties) }),
          ...(input.currentOwnerId !== undefined && { currentOwnerId: input.currentOwnerId }),
          ...(input.currentLocationId !== undefined && {
            currentLocationId: input.currentLocationId,
          }),
          ...(input.metadata !== undefined && { metadata: toJson(input.metadata) }),
        },
      });
      if (result.count === 0) return reply.status(404).send({ error: 'Item not found' });
      const item = await prisma.item.findUnique({ where: { id: req.params.itemId } });
      return { item };
    },
  );

  app.delete<{ Params: ItemParam }>(
    '/api/projects/:projectId/items/:itemId',
    async (req, reply) => {
      if (!(await assertProjectOwnership(req.params.projectId, req.user!.id))) {
        return reply.status(404).send({ error: 'Project not found' });
      }
      const result = await prisma.item.deleteMany({
        where: { id: req.params.itemId, projectId: req.params.projectId },
      });
      if (result.count === 0) return reply.status(404).send({ error: 'Item not found' });
      return reply.status(204).send();
    },
  );

  // ----- Item timeline points ---------------------------------------------

  app.get<{ Params: ItemParam }>(
    '/api/projects/:projectId/items/:itemId/timeline',
    async (req, reply) => {
      if (!(await assertProjectOwnership(req.params.projectId, req.user!.id))) {
        return reply.status(404).send({ error: 'Project not found' });
      }
      const item = await prisma.item.findFirst({
        where: { id: req.params.itemId, projectId: req.params.projectId },
        select: { id: true },
      });
      if (!item) return reply.status(404).send({ error: 'Item not found' });
      const points = await prisma.itemTimelinePoint.findMany({
        where: { itemId: req.params.itemId },
        orderBy: [{ orderIndex: 'asc' }, { createdAt: 'asc' }],
      });
      return { points };
    },
  );

  app.post<{ Params: ItemParam }>(
    '/api/projects/:projectId/items/:itemId/timeline',
    async (req, reply) => {
      if (!(await assertProjectOwnership(req.params.projectId, req.user!.id))) {
        return reply.status(404).send({ error: 'Project not found' });
      }
      const item = await prisma.item.findFirst({
        where: { id: req.params.itemId, projectId: req.params.projectId },
        select: { id: true },
      });
      if (!item) return reply.status(404).send({ error: 'Item not found' });
      const input = itemTimelinePointCreateSchema.parse(req.body);
      const point = await prisma.itemTimelinePoint.create({
        data: {
          projectId: req.params.projectId,
          itemId: req.params.itemId,
          at: input.at,
          ownerId: input.ownerId ?? null,
          locationId: input.locationId ?? null,
          eventId: input.eventId ?? null,
          note: input.note ?? null,
          orderIndex: input.orderIndex ?? 0,
        },
      });
      return reply.status(201).send({ point });
    },
  );

  app.patch<{ Params: TimelinePointParam }>(
    '/api/projects/:projectId/items/:itemId/timeline/:pointId',
    async (req, reply) => {
      if (!(await assertProjectOwnership(req.params.projectId, req.user!.id))) {
        return reply.status(404).send({ error: 'Project not found' });
      }
      const input = itemTimelinePointUpdateSchema.parse(req.body);
      const result = await prisma.itemTimelinePoint.updateMany({
        where: {
          id: req.params.pointId,
          itemId: req.params.itemId,
          projectId: req.params.projectId,
        },
        data: {
          ...(input.at !== undefined && { at: input.at }),
          ...(input.ownerId !== undefined && { ownerId: input.ownerId }),
          ...(input.locationId !== undefined && { locationId: input.locationId }),
          ...(input.eventId !== undefined && { eventId: input.eventId }),
          ...(input.note !== undefined && { note: input.note }),
          ...(input.orderIndex !== undefined && { orderIndex: input.orderIndex }),
        },
      });
      if (result.count === 0) return reply.status(404).send({ error: 'Point not found' });
      const point = await prisma.itemTimelinePoint.findUnique({
        where: { id: req.params.pointId },
      });
      return { point };
    },
  );

  app.delete<{ Params: TimelinePointParam }>(
    '/api/projects/:projectId/items/:itemId/timeline/:pointId',
    async (req, reply) => {
      if (!(await assertProjectOwnership(req.params.projectId, req.user!.id))) {
        return reply.status(404).send({ error: 'Project not found' });
      }
      const result = await prisma.itemTimelinePoint.deleteMany({
        where: {
          id: req.params.pointId,
          itemId: req.params.itemId,
          projectId: req.params.projectId,
        },
      });
      if (result.count === 0) return reply.status(404).send({ error: 'Point not found' });
      return reply.status(204).send();
    },
  );
};
