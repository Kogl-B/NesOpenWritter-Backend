import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { assertProjectOwnership } from '../lib/access.js';

const snapshotCreateSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().max(2000).optional().nullable(),
  eventId: z.string().optional().nullable(),
});

const snapshotListSchema = z.object({
  eventId: z.string().optional(),
});

/**
 * v1.1 — Снапшоты состояния мира.
 *
 * Snapshot captures the state of the world at a specific point:
 * characters (status, positions), items (ownership), locations,
 * active relations and event participants.
 */
export async function snapshotRoutes(app: FastifyInstance) {
  app.get<{ Params: { projectId: string } }>(
    '/api/projects/:projectId/snapshots',
    async (req, reply) => {
      app.requireAuth(req);
      if (!(await assertProjectOwnership(req.params.projectId, req.user!.id))) {
        return reply.status(404).send({ error: 'Project not found' });
      }
      const parsed = snapshotListSchema.parse(req.query);
      const snapshots = await prisma.worldSnapshot.findMany({
        where: {
          projectId: req.params.projectId,
          ...(parsed.eventId ? { eventId: parsed.eventId } : {}),
        },
        select: {
          id: true,
          name: true,
          description: true,
          eventId: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'desc' },
      });
      return { snapshots };
    },
  );

  app.get<{ Params: { projectId: string; snapshotId: string } }>(
    '/api/projects/:projectId/snapshots/:snapshotId',
    async (req, reply) => {
      app.requireAuth(req);
      if (!(await assertProjectOwnership(req.params.projectId, req.user!.id))) {
        return reply.status(404).send({ error: 'Project not found' });
      }
      const snapshot = await prisma.worldSnapshot.findFirst({
        where: {
          id: req.params.snapshotId,
          projectId: req.params.projectId,
        },
        include: {
          event: {
            select: { id: true, name: true, at: true },
          },
        },
      });
      if (!snapshot) return reply.status(404).send({ error: 'Snapshot not found' });
      return { snapshot };
    },
  );

  app.post<{ Params: { projectId: string } }>(
    '/api/projects/:projectId/snapshots',
    async (req, reply) => {
      app.requireAuth(req);
      if (!(await assertProjectOwnership(req.params.projectId, req.user!.id))) {
        return reply.status(404).send({ error: 'Project not found' });
      }
      const input = snapshotCreateSchema.parse(req.body);

      // Capture world state at this moment
      const [characters, items, locations, events, relations] = await Promise.all([
        prisma.character.findMany({
          where: { projectId: req.params.projectId },
          select: {
            id: true, name: true, status: true, faction: true,
            shortName: true, dateOfBirth: true, dateOfDeath: true,
          },
        }),
        prisma.item.findMany({
          where: { projectId: req.params.projectId },
          select: {
            id: true, name: true, category: true, rarity: true,
            currentOwnerId: true, currentLocationId: true,
          },
        }),
        prisma.location.findMany({
          where: { projectId: req.params.projectId },
          select: {
            id: true, name: true, kind: true, parentLocationId: true, lodLevel: true,
          },
        }),
        prisma.timelineEvent.findMany({
          where: { projectId: req.params.projectId },
          select: {
            id: true, name: true, at: true, atNumeric: true, importance: true,
          },
          orderBy: { atNumeric: 'asc' },
        }),
        prisma.characterRelation.findMany({
          where: { projectId: req.params.projectId },
          select: {
            fromCharacterId: true, toCharacterId: true,
            relationType: true, strength: true,
          },
        }),
      ]);

      // Build character name map for readability
      const charNames = Object.fromEntries(characters.map((c) => [c.id, c.name]));

      const state = {
        capturedAt: new Date().toISOString(),
        characters: characters.map((c) => ({
          ...c,
          faction: c.faction ?? null,
        })),
        items: items.map((i) => ({
          ...i,
          ownerName: i.currentOwnerId ? charNames[i.currentOwnerId] ?? null : null,
          locationName: i.currentLocationId
            ? locations.find((l) => l.id === i.currentLocationId)?.name ?? null
            : null,
        })),
        locations,
        timeline: events,
        relations: relations.map((r) => ({
          ...r,
          fromName: charNames[r.fromCharacterId] ?? null,
          toName: charNames[r.toCharacterId] ?? null,
        })),
        summary: {
          totalCharacters: characters.length,
          aliveCharacters: characters.filter((c) => c.status === 'alive').length,
          deadCharacters: characters.filter((c) => c.status === 'dead').length,
          totalItems: items.length,
          totalLocations: locations.length,
          totalEvents: events.length,
          totalRelations: relations.length,
        },
      };

      const snapshot = await prisma.worldSnapshot.create({
        data: {
          projectId: req.params.projectId,
          eventId: input.eventId ?? null,
          name: input.name,
          description: input.description ?? null,
          state: state as object,
        },
      });

      return reply.status(201).send({ snapshot });
    },
  );

  app.delete<{ Params: { projectId: string; snapshotId: string } }>(
    '/api/projects/:projectId/snapshots/:snapshotId',
    async (req, reply) => {
      app.requireAuth(req);
      if (!(await assertProjectOwnership(req.params.projectId, req.user!.id))) {
        return reply.status(404).send({ error: 'Project not found' });
      }
      try {
        await prisma.worldSnapshot.delete({
          where: { id: req.params.snapshotId },
        });
        return reply.status(204).send();
      } catch {
        return reply.status(404).send({ error: 'Snapshot not found' });
      }
    },
  );
}
