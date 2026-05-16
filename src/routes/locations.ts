import type { FastifyPluginAsync } from 'fastify';

import { prisma } from '../lib/prisma.js';
import { assertProjectOwnership, toJson } from '../lib/access.js';
import { locationCreateSchema, locationUpdateSchema } from '../lib/schemas.js';

type ProjectParam = { projectId: string };
type LocationParam = { projectId: string; locationId: string };

export const locationRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', async (req) => {
    app.requireAuth(req);
  });

  app.get<{ Params: ProjectParam }>(
    '/api/projects/:projectId/locations',
    async (req, reply) => {
      if (!(await assertProjectOwnership(req.params.projectId, req.user!.id))) {
        return reply.status(404).send({ error: 'Project not found' });
      }
      const locations = await prisma.location.findMany({
        where: { projectId: req.params.projectId },
        orderBy: [{ lodLevel: 'asc' }, { name: 'asc' }],
      });
      return { locations };
    },
  );

  app.post<{ Params: ProjectParam }>(
    '/api/projects/:projectId/locations',
    async (req, reply) => {
      if (!(await assertProjectOwnership(req.params.projectId, req.user!.id))) {
        return reply.status(404).send({ error: 'Project not found' });
      }
      const input = locationCreateSchema.parse(req.body);
      // verify parent location belongs to same project, if provided
      if (input.parentLocationId) {
        const parent = await prisma.location.findFirst({
          where: { id: input.parentLocationId, projectId: req.params.projectId },
          select: { id: true },
        });
        if (!parent) {
          return reply.status(400).send({ error: 'Parent location not in project' });
        }
      }
      const location = await prisma.location.create({
        data: {
          projectId: req.params.projectId,
          name: input.name,
          shortName: input.shortName ?? null,
          kind: input.kind ?? 'place',
          parentLocationId: input.parentLocationId ?? null,
          lodLevel: input.lodLevel ?? 0,
          coordX: input.coordX ?? null,
          coordY: input.coordY ?? null,
          description: input.description ?? null,
          metadata: toJson(input.metadata),
        },
      });
      return reply.status(201).send({ location });
    },
  );

  app.get<{ Params: LocationParam }>(
    '/api/projects/:projectId/locations/:locationId',
    async (req, reply) => {
      if (!(await assertProjectOwnership(req.params.projectId, req.user!.id))) {
        return reply.status(404).send({ error: 'Project not found' });
      }
      const location = await prisma.location.findFirst({
        where: { id: req.params.locationId, projectId: req.params.projectId },
      });
      if (!location) return reply.status(404).send({ error: 'Location not found' });
      return { location };
    },
  );

  app.patch<{ Params: LocationParam }>(
    '/api/projects/:projectId/locations/:locationId',
    async (req, reply) => {
      if (!(await assertProjectOwnership(req.params.projectId, req.user!.id))) {
        return reply.status(404).send({ error: 'Project not found' });
      }
      const input = locationUpdateSchema.parse(req.body);
      if (input.parentLocationId) {
        if (input.parentLocationId === req.params.locationId) {
          return reply.status(400).send({ error: 'Location cannot be its own parent' });
        }
        const parent = await prisma.location.findFirst({
          where: { id: input.parentLocationId, projectId: req.params.projectId },
          select: { id: true },
        });
        if (!parent) {
          return reply.status(400).send({ error: 'Parent location not in project' });
        }
      }
      const result = await prisma.location.updateMany({
        where: { id: req.params.locationId, projectId: req.params.projectId },
        data: {
          ...(input.name !== undefined && { name: input.name }),
          ...(input.shortName !== undefined && { shortName: input.shortName }),
          ...(input.kind !== undefined && { kind: input.kind }),
          ...(input.parentLocationId !== undefined && {
            parentLocationId: input.parentLocationId,
          }),
          ...(input.lodLevel !== undefined && { lodLevel: input.lodLevel }),
          ...(input.coordX !== undefined && { coordX: input.coordX }),
          ...(input.coordY !== undefined && { coordY: input.coordY }),
          ...(input.description !== undefined && { description: input.description }),
          ...(input.metadata !== undefined && { metadata: toJson(input.metadata) }),
        },
      });
      if (result.count === 0) return reply.status(404).send({ error: 'Location not found' });
      const location = await prisma.location.findUnique({
        where: { id: req.params.locationId },
      });
      return { location };
    },
  );

  app.delete<{ Params: LocationParam }>(
    '/api/projects/:projectId/locations/:locationId',
    async (req, reply) => {
      if (!(await assertProjectOwnership(req.params.projectId, req.user!.id))) {
        return reply.status(404).send({ error: 'Project not found' });
      }
      const result = await prisma.location.deleteMany({
        where: { id: req.params.locationId, projectId: req.params.projectId },
      });
      if (result.count === 0) return reply.status(404).send({ error: 'Location not found' });
      return reply.status(204).send();
    },
  );
};
