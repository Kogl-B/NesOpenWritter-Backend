import type { FastifyPluginAsync } from 'fastify';

import { prisma } from '../lib/prisma.js';
import { assertProjectOwnership, toJson } from '../lib/access.js';
import {
  mapElementCreateSchema,
  mapElementUpdateSchema,
  mapDrawingCreateSchema,
  mapDrawingUpdateSchema,
} from '../lib/schemas.js';

type ProjectParam = { projectId: string };
type ElementParam = { projectId: string; elementId: string };
type DrawingParam = { projectId: string; drawingId: string };

export const mapRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', async (req) => {
    app.requireAuth(req);
  });

  // ----- MapElements -------------------------------------------------------

  app.get<{ Params: ProjectParam; Querystring: { lod?: string } }>(
    '/api/projects/:projectId/map-elements',
    async (req, reply) => {
      if (!(await assertProjectOwnership(req.params.projectId, req.user!.id))) {
        return reply.status(404).send({ error: 'Project not found' });
      }
      const lodFilter = req.query.lod !== undefined ? Number.parseInt(req.query.lod, 10) : null;
      const elements = await prisma.mapElement.findMany({
        where: {
          projectId: req.params.projectId,
          ...(lodFilter !== null &&
            Number.isFinite(lodFilter) && {
              lodMin: { lte: lodFilter },
              lodMax: { gte: lodFilter },
            }),
        },
        orderBy: { createdAt: 'asc' },
      });
      return { elements };
    },
  );

  app.post<{ Params: ProjectParam }>(
    '/api/projects/:projectId/map-elements',
    async (req, reply) => {
      if (!(await assertProjectOwnership(req.params.projectId, req.user!.id))) {
        return reply.status(404).send({ error: 'Project not found' });
      }
      const input = mapElementCreateSchema.parse(req.body);
      if (input.locationId) {
        const loc = await prisma.location.findFirst({
          where: { id: input.locationId, projectId: req.params.projectId },
          select: { id: true },
        });
        if (!loc) return reply.status(400).send({ error: 'Location not in project' });
      }
      const element = await prisma.mapElement.create({
        data: {
          projectId: req.params.projectId,
          name: input.name,
          description: input.description ?? null,
          kind: input.kind,
          subkind: input.subkind ?? null,
          locationId: input.locationId ?? null,
          geometry: toJson(input.geometry as Record<string, unknown>),
          style: toJson(input.style),
          lodMin: input.lodMin ?? 0,
          lodMax: input.lodMax ?? 4,
          metadata: toJson(input.metadata),
        },
      });
      return reply.status(201).send({ element });
    },
  );

  app.get<{ Params: ElementParam }>(
    '/api/projects/:projectId/map-elements/:elementId',
    async (req, reply) => {
      if (!(await assertProjectOwnership(req.params.projectId, req.user!.id))) {
        return reply.status(404).send({ error: 'Project not found' });
      }
      const element = await prisma.mapElement.findFirst({
        where: { id: req.params.elementId, projectId: req.params.projectId },
      });
      if (!element) return reply.status(404).send({ error: 'Element not found' });
      return { element };
    },
  );

  app.patch<{ Params: ElementParam }>(
    '/api/projects/:projectId/map-elements/:elementId',
    async (req, reply) => {
      if (!(await assertProjectOwnership(req.params.projectId, req.user!.id))) {
        return reply.status(404).send({ error: 'Project not found' });
      }
      const input = mapElementUpdateSchema.parse(req.body);
      if (input.locationId) {
        const loc = await prisma.location.findFirst({
          where: { id: input.locationId, projectId: req.params.projectId },
          select: { id: true },
        });
        if (!loc) return reply.status(400).send({ error: 'Location not in project' });
      }
      const result = await prisma.mapElement.updateMany({
        where: { id: req.params.elementId, projectId: req.params.projectId },
        data: {
          ...(input.name !== undefined && { name: input.name }),
          ...(input.description !== undefined && { description: input.description }),
          ...(input.kind !== undefined && { kind: input.kind }),
          ...(input.subkind !== undefined && { subkind: input.subkind }),
          ...(input.locationId !== undefined && { locationId: input.locationId }),
          ...(input.geometry !== undefined && {
            geometry: toJson(input.geometry as Record<string, unknown>),
          }),
          ...(input.style !== undefined && { style: toJson(input.style) }),
          ...(input.lodMin !== undefined && { lodMin: input.lodMin }),
          ...(input.lodMax !== undefined && { lodMax: input.lodMax }),
          ...(input.metadata !== undefined && { metadata: toJson(input.metadata) }),
        },
      });
      if (result.count === 0) return reply.status(404).send({ error: 'Element not found' });
      const element = await prisma.mapElement.findUnique({
        where: { id: req.params.elementId },
      });
      return { element };
    },
  );

  app.delete<{ Params: ElementParam }>(
    '/api/projects/:projectId/map-elements/:elementId',
    async (req, reply) => {
      if (!(await assertProjectOwnership(req.params.projectId, req.user!.id))) {
        return reply.status(404).send({ error: 'Project not found' });
      }
      const result = await prisma.mapElement.deleteMany({
        where: { id: req.params.elementId, projectId: req.params.projectId },
      });
      if (result.count === 0) return reply.status(404).send({ error: 'Element not found' });
      return reply.status(204).send();
    },
  );

  // ----- MapDrawings (heavy JSON) -----------------------------------------

  app.get<{
    Params: ProjectParam;
    Querystring: { page?: string; pageSize?: string; layer?: string };
  }>('/api/projects/:projectId/map-drawings', async (req, reply) => {
    if (!(await assertProjectOwnership(req.params.projectId, req.user!.id))) {
      return reply.status(404).send({ error: 'Project not found' });
    }
    const page = Math.max(1, Number.parseInt(req.query.page ?? '1', 10) || 1);
    const pageSize = Math.min(
      100,
      Math.max(1, Number.parseInt(req.query.pageSize ?? '20', 10) || 20),
    );
    const where = {
      projectId: req.params.projectId,
      ...(req.query.layer && { layer: req.query.layer }),
    };
    const [total, drawings] = await Promise.all([
      prisma.mapDrawing.count({ where }),
      prisma.mapDrawing.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        // payload is heavy: only return summary by default
        select: {
          id: true,
          projectId: true,
          name: true,
          layer: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
    ]);
    return { drawings, page, pageSize, total };
  });

  app.post<{ Params: ProjectParam }>(
    '/api/projects/:projectId/map-drawings',
    async (req, reply) => {
      if (!(await assertProjectOwnership(req.params.projectId, req.user!.id))) {
        return reply.status(404).send({ error: 'Project not found' });
      }
      const input = mapDrawingCreateSchema.parse(req.body);
      const drawing = await prisma.mapDrawing.create({
        data: {
          projectId: req.params.projectId,
          name: input.name,
          layer: input.layer ?? 'default',
          payload: toJson(input.payload),
        },
      });
      return reply.status(201).send({ drawing });
    },
  );

  app.get<{ Params: DrawingParam }>(
    '/api/projects/:projectId/map-drawings/:drawingId',
    async (req, reply) => {
      if (!(await assertProjectOwnership(req.params.projectId, req.user!.id))) {
        return reply.status(404).send({ error: 'Project not found' });
      }
      const drawing = await prisma.mapDrawing.findFirst({
        where: { id: req.params.drawingId, projectId: req.params.projectId },
      });
      if (!drawing) return reply.status(404).send({ error: 'Drawing not found' });
      return { drawing };
    },
  );

  app.patch<{ Params: DrawingParam }>(
    '/api/projects/:projectId/map-drawings/:drawingId',
    async (req, reply) => {
      if (!(await assertProjectOwnership(req.params.projectId, req.user!.id))) {
        return reply.status(404).send({ error: 'Project not found' });
      }
      const input = mapDrawingUpdateSchema.parse(req.body);
      const result = await prisma.mapDrawing.updateMany({
        where: { id: req.params.drawingId, projectId: req.params.projectId },
        data: {
          ...(input.name !== undefined && { name: input.name }),
          ...(input.layer !== undefined && { layer: input.layer }),
          ...(input.payload !== undefined && { payload: toJson(input.payload) }),
        },
      });
      if (result.count === 0) return reply.status(404).send({ error: 'Drawing not found' });
      const drawing = await prisma.mapDrawing.findUnique({
        where: { id: req.params.drawingId },
      });
      return { drawing };
    },
  );

  app.delete<{ Params: DrawingParam }>(
    '/api/projects/:projectId/map-drawings/:drawingId',
    async (req, reply) => {
      if (!(await assertProjectOwnership(req.params.projectId, req.user!.id))) {
        return reply.status(404).send({ error: 'Project not found' });
      }
      const result = await prisma.mapDrawing.deleteMany({
        where: { id: req.params.drawingId, projectId: req.params.projectId },
      });
      if (result.count === 0) return reply.status(404).send({ error: 'Drawing not found' });
      return reply.status(204).send();
    },
  );
};
