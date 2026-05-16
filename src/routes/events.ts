import type { FastifyPluginAsync } from 'fastify';

import { prisma } from '../lib/prisma.js';
import { assertProjectOwnership, toJson } from '../lib/access.js';
import {
  eventCreateSchema,
  eventUpdateSchema,
  eventCharacterCreateSchema,
  eventCharacterUpdateSchema,
  eventItemCreateSchema,
  eventItemUpdateSchema,
  characterPositionCreateSchema,
  characterPositionUpdateSchema,
} from '../lib/schemas.js';

type ProjectParam = { projectId: string };
type EventParam = { projectId: string; eventId: string };
type EventCharParam = { projectId: string; eventId: string; characterId: string };
type EventItemParam = { projectId: string; eventId: string; itemId: string };
type PositionParam = { projectId: string; positionId: string };

export const eventRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', async (req) => {
    app.requireAuth(req);
  });

  // ----- Events CRUD -------------------------------------------------------

  app.get<{ Params: ProjectParam }>(
    '/api/projects/:projectId/events',
    async (req, reply) => {
      if (!(await assertProjectOwnership(req.params.projectId, req.user!.id))) {
        return reply.status(404).send({ error: 'Project not found' });
      }
      const events = await prisma.timelineEvent.findMany({
        where: { projectId: req.params.projectId },
        orderBy: [{ atNumeric: 'asc' }, { createdAt: 'asc' }],
      });
      return { events };
    },
  );

  app.post<{ Params: ProjectParam }>(
    '/api/projects/:projectId/events',
    async (req, reply) => {
      if (!(await assertProjectOwnership(req.params.projectId, req.user!.id))) {
        return reply.status(404).send({ error: 'Project not found' });
      }
      const input = eventCreateSchema.parse(req.body);
      if (input.locationId) {
        const loc = await prisma.location.findFirst({
          where: { id: input.locationId, projectId: req.params.projectId },
          select: { id: true },
        });
        if (!loc) return reply.status(400).send({ error: 'Location not in project' });
      }
      const event = await prisma.timelineEvent.create({
        data: {
          projectId: req.params.projectId,
          name: input.name,
          summary: input.summary ?? null,
          description: input.description ?? null,
          at: input.at,
          atNumeric: input.atNumeric ?? null,
          durationNumeric: input.durationNumeric ?? null,
          locationId: input.locationId ?? null,
          color: input.color ?? null,
          icon: input.icon ?? null,
          importance: input.importance ?? 3,
          metadata: toJson(input.metadata),
        },
      });
      return reply.status(201).send({ event });
    },
  );

  app.get<{ Params: EventParam }>(
    '/api/projects/:projectId/events/:eventId',
    async (req, reply) => {
      if (!(await assertProjectOwnership(req.params.projectId, req.user!.id))) {
        return reply.status(404).send({ error: 'Project not found' });
      }
      const event = await prisma.timelineEvent.findFirst({
        where: { id: req.params.eventId, projectId: req.params.projectId },
      });
      if (!event) return reply.status(404).send({ error: 'Event not found' });
      return { event };
    },
  );

  app.patch<{ Params: EventParam }>(
    '/api/projects/:projectId/events/:eventId',
    async (req, reply) => {
      if (!(await assertProjectOwnership(req.params.projectId, req.user!.id))) {
        return reply.status(404).send({ error: 'Project not found' });
      }
      const input = eventUpdateSchema.parse(req.body);
      if (input.locationId) {
        const loc = await prisma.location.findFirst({
          where: { id: input.locationId, projectId: req.params.projectId },
          select: { id: true },
        });
        if (!loc) return reply.status(400).send({ error: 'Location not in project' });
      }
      const result = await prisma.timelineEvent.updateMany({
        where: { id: req.params.eventId, projectId: req.params.projectId },
        data: {
          ...(input.name !== undefined && { name: input.name }),
          ...(input.summary !== undefined && { summary: input.summary }),
          ...(input.description !== undefined && { description: input.description }),
          ...(input.at !== undefined && { at: input.at }),
          ...(input.atNumeric !== undefined && { atNumeric: input.atNumeric }),
          ...(input.durationNumeric !== undefined && {
            durationNumeric: input.durationNumeric,
          }),
          ...(input.locationId !== undefined && { locationId: input.locationId }),
          ...(input.color !== undefined && { color: input.color }),
          ...(input.icon !== undefined && { icon: input.icon }),
          ...(input.importance !== undefined && { importance: input.importance }),
          ...(input.metadata !== undefined && { metadata: toJson(input.metadata) }),
        },
      });
      if (result.count === 0) return reply.status(404).send({ error: 'Event not found' });
      const event = await prisma.timelineEvent.findUnique({
        where: { id: req.params.eventId },
      });
      return { event };
    },
  );

  app.delete<{ Params: EventParam }>(
    '/api/projects/:projectId/events/:eventId',
    async (req, reply) => {
      if (!(await assertProjectOwnership(req.params.projectId, req.user!.id))) {
        return reply.status(404).send({ error: 'Project not found' });
      }
      const result = await prisma.timelineEvent.deleteMany({
        where: { id: req.params.eventId, projectId: req.params.projectId },
      });
      if (result.count === 0) return reply.status(404).send({ error: 'Event not found' });
      return reply.status(204).send();
    },
  );

  // ----- Event-Character links --------------------------------------------

  app.get<{ Params: EventParam }>(
    '/api/projects/:projectId/events/:eventId/characters',
    async (req, reply) => {
      if (!(await assertProjectOwnership(req.params.projectId, req.user!.id))) {
        return reply.status(404).send({ error: 'Project not found' });
      }
      const event = await prisma.timelineEvent.findFirst({
        where: { id: req.params.eventId, projectId: req.params.projectId },
        select: { id: true },
      });
      if (!event) return reply.status(404).send({ error: 'Event not found' });
      const links = await prisma.eventCharacter.findMany({
        where: { eventId: req.params.eventId },
        orderBy: { createdAt: 'asc' },
      });
      return { links };
    },
  );

  app.post<{ Params: EventParam }>(
    '/api/projects/:projectId/events/:eventId/characters',
    async (req, reply) => {
      if (!(await assertProjectOwnership(req.params.projectId, req.user!.id))) {
        return reply.status(404).send({ error: 'Project not found' });
      }
      const event = await prisma.timelineEvent.findFirst({
        where: { id: req.params.eventId, projectId: req.params.projectId },
        select: { id: true },
      });
      if (!event) return reply.status(404).send({ error: 'Event not found' });
      const input = eventCharacterCreateSchema.parse(req.body);
      const character = await prisma.character.findFirst({
        where: { id: input.characterId, projectId: req.params.projectId },
        select: { id: true },
      });
      if (!character) return reply.status(400).send({ error: 'Character not in project' });
      const link = await prisma.eventCharacter.create({
        data: {
          eventId: req.params.eventId,
          characterId: input.characterId,
          role: input.role ?? 'participant',
          note: input.note ?? null,
        },
      });
      return reply.status(201).send({ link });
    },
  );

  app.patch<{ Params: EventCharParam }>(
    '/api/projects/:projectId/events/:eventId/characters/:characterId',
    async (req, reply) => {
      if (!(await assertProjectOwnership(req.params.projectId, req.user!.id))) {
        return reply.status(404).send({ error: 'Project not found' });
      }
      const input = eventCharacterUpdateSchema.parse(req.body);
      try {
        const link = await prisma.eventCharacter.update({
          where: {
            eventId_characterId: {
              eventId: req.params.eventId,
              characterId: req.params.characterId,
            },
          },
          data: {
            ...(input.role !== undefined && { role: input.role }),
            ...(input.note !== undefined && { note: input.note }),
          },
        });
        return { link };
      } catch {
        return reply.status(404).send({ error: 'Link not found' });
      }
    },
  );

  app.delete<{ Params: EventCharParam }>(
    '/api/projects/:projectId/events/:eventId/characters/:characterId',
    async (req, reply) => {
      if (!(await assertProjectOwnership(req.params.projectId, req.user!.id))) {
        return reply.status(404).send({ error: 'Project not found' });
      }
      try {
        await prisma.eventCharacter.delete({
          where: {
            eventId_characterId: {
              eventId: req.params.eventId,
              characterId: req.params.characterId,
            },
          },
        });
        return reply.status(204).send();
      } catch {
        return reply.status(404).send({ error: 'Link not found' });
      }
    },
  );

  // ----- Event-Item links -------------------------------------------------

  app.get<{ Params: EventParam }>(
    '/api/projects/:projectId/events/:eventId/items',
    async (req, reply) => {
      if (!(await assertProjectOwnership(req.params.projectId, req.user!.id))) {
        return reply.status(404).send({ error: 'Project not found' });
      }
      const event = await prisma.timelineEvent.findFirst({
        where: { id: req.params.eventId, projectId: req.params.projectId },
        select: { id: true },
      });
      if (!event) return reply.status(404).send({ error: 'Event not found' });
      const links = await prisma.eventItem.findMany({
        where: { eventId: req.params.eventId },
        orderBy: { createdAt: 'asc' },
      });
      return { links };
    },
  );

  app.post<{ Params: EventParam }>(
    '/api/projects/:projectId/events/:eventId/items',
    async (req, reply) => {
      if (!(await assertProjectOwnership(req.params.projectId, req.user!.id))) {
        return reply.status(404).send({ error: 'Project not found' });
      }
      const event = await prisma.timelineEvent.findFirst({
        where: { id: req.params.eventId, projectId: req.params.projectId },
        select: { id: true },
      });
      if (!event) return reply.status(404).send({ error: 'Event not found' });
      const input = eventItemCreateSchema.parse(req.body);
      const item = await prisma.item.findFirst({
        where: { id: input.itemId, projectId: req.params.projectId },
        select: { id: true },
      });
      if (!item) return reply.status(400).send({ error: 'Item not in project' });
      const link = await prisma.eventItem.create({
        data: {
          eventId: req.params.eventId,
          itemId: input.itemId,
          note: input.note ?? null,
        },
      });
      return reply.status(201).send({ link });
    },
  );

  app.patch<{ Params: EventItemParam }>(
    '/api/projects/:projectId/events/:eventId/items/:itemId',
    async (req, reply) => {
      if (!(await assertProjectOwnership(req.params.projectId, req.user!.id))) {
        return reply.status(404).send({ error: 'Project not found' });
      }
      const input = eventItemUpdateSchema.parse(req.body);
      try {
        const link = await prisma.eventItem.update({
          where: {
            eventId_itemId: { eventId: req.params.eventId, itemId: req.params.itemId },
          },
          data: { ...(input.note !== undefined && { note: input.note }) },
        });
        return { link };
      } catch {
        return reply.status(404).send({ error: 'Link not found' });
      }
    },
  );

  app.delete<{ Params: EventItemParam }>(
    '/api/projects/:projectId/events/:eventId/items/:itemId',
    async (req, reply) => {
      if (!(await assertProjectOwnership(req.params.projectId, req.user!.id))) {
        return reply.status(404).send({ error: 'Project not found' });
      }
      try {
        await prisma.eventItem.delete({
          where: {
            eventId_itemId: { eventId: req.params.eventId, itemId: req.params.itemId },
          },
        });
        return reply.status(204).send();
      } catch {
        return reply.status(404).send({ error: 'Link not found' });
      }
    },
  );

  // ----- Character positions (per event) ----------------------------------

  app.post<{ Params: ProjectParam }>(
    '/api/projects/:projectId/character-positions',
    async (req, reply) => {
      if (!(await assertProjectOwnership(req.params.projectId, req.user!.id))) {
        return reply.status(404).send({ error: 'Project not found' });
      }
      const input = characterPositionCreateSchema.parse(req.body);
      const char = await prisma.character.findFirst({
        where: { id: input.characterId, projectId: req.params.projectId },
        select: { id: true },
      });
      if (!char) return reply.status(400).send({ error: 'Character not in project' });
      const event = await prisma.timelineEvent.findFirst({
        where: { id: input.eventId, projectId: req.params.projectId },
        select: { id: true },
      });
      if (!event) return reply.status(400).send({ error: 'Event not in project' });
      if (input.locationId) {
        const loc = await prisma.location.findFirst({
          where: { id: input.locationId, projectId: req.params.projectId },
          select: { id: true },
        });
        if (!loc) return reply.status(400).send({ error: 'Location not in project' });
      }
      const position = await prisma.characterPosition.create({
        data: {
          projectId: req.params.projectId,
          characterId: input.characterId,
          eventId: input.eventId,
          locationId: input.locationId ?? null,
          coordX: input.coordX ?? null,
          coordY: input.coordY ?? null,
          metadata: toJson(input.metadata),
        },
      });
      return reply.status(201).send({ position });
    },
  );

  app.patch<{ Params: PositionParam }>(
    '/api/projects/:projectId/character-positions/:positionId',
    async (req, reply) => {
      if (!(await assertProjectOwnership(req.params.projectId, req.user!.id))) {
        return reply.status(404).send({ error: 'Project not found' });
      }
      const input = characterPositionUpdateSchema.parse(req.body);
      const result = await prisma.characterPosition.updateMany({
        where: { id: req.params.positionId, projectId: req.params.projectId },
        data: {
          ...(input.locationId !== undefined && { locationId: input.locationId }),
          ...(input.coordX !== undefined && { coordX: input.coordX }),
          ...(input.coordY !== undefined && { coordY: input.coordY }),
          ...(input.metadata !== undefined && { metadata: toJson(input.metadata) }),
        },
      });
      if (result.count === 0) return reply.status(404).send({ error: 'Position not found' });
      const position = await prisma.characterPosition.findUnique({
        where: { id: req.params.positionId },
      });
      return { position };
    },
  );

  app.delete<{ Params: PositionParam }>(
    '/api/projects/:projectId/character-positions/:positionId',
    async (req, reply) => {
      if (!(await assertProjectOwnership(req.params.projectId, req.user!.id))) {
        return reply.status(404).send({ error: 'Project not found' });
      }
      const result = await prisma.characterPosition.deleteMany({
        where: { id: req.params.positionId, projectId: req.params.projectId },
      });
      if (result.count === 0) return reply.status(404).send({ error: 'Position not found' });
      return reply.status(204).send();
    },
  );
};
