import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { assertProjectOwnership } from '../lib/access.js';

const currencySchema = z.object({
  name: z.string().trim().min(1).max(100),
  code: z.string().trim().min(1).max(10).toUpperCase(),
  symbol: z.string().max(10).optional().nullable(),
  exchangeRate: z.record(z.string(), z.number()).optional(),
});

const resourceSchema = z.object({
  name: z.string().trim().min(1).max(200),
  category: z.enum(['mineral', 'food', 'magic', 'technology', 'material', 'other']),
  rarity: z.enum(['common', 'uncommon', 'rare', 'legendary']).default('common'),
  description: z.string().max(2000).optional().nullable(),
  unit: z.string().max(20).default('unit'),
  basePrice: z.number().positive().optional().nullable(),
  currencyId: z.string().optional().nullable(),
});

const tradeRouteSchema = z.object({
  name: z.string().trim().min(1).max(200),
  fromLocationId: z.string().optional().nullable(),
  toLocationId: z.string().optional().nullable(),
  distanceKm: z.number().positive().optional().nullable(),
  travelDays: z.number().int().positive().optional().nullable(),
  danger: z.enum(['low', 'medium', 'high', 'extreme']).default('low'),
  description: z.string().max(2000).optional().nullable(),
}).refine(
  (data) =>
    !data.fromLocationId ||
    !data.toLocationId ||
    data.fromLocationId !== data.toLocationId,
  { message: 'Откуда и куда должны различаться' },
);

/**
 * v1.3 — Экономика: валюты, ресурсы, торговые пути.
 */
export async function economyRoutes(app: FastifyInstance) {
  // === Currencies ===
  app.get<{ Params: { projectId: string } }>(
    '/api/projects/:projectId/economy/currencies',
    async (req, reply) => {
      app.requireAuth(req);
      if (!(await assertProjectOwnership(req.params.projectId, req.user!.id))) {
        return reply.status(404).send({ error: 'Project not found' });
      }
      const currencies = await prisma.currency.findMany({
        where: { projectId: req.params.projectId },
        include: { _count: { select: { resources: true } } },
      });
      return { currencies };
    },
  );

  app.post<{ Params: { projectId: string } }>(
    '/api/projects/:projectId/economy/currencies',
    async (req, reply) => {
      app.requireAuth(req);
      if (!(await assertProjectOwnership(req.params.projectId, req.user!.id))) {
        return reply.status(404).send({ error: 'Project not found' });
      }
      const input = currencySchema.parse(req.body);
      let currency;
      try {
        currency = await prisma.currency.create({
          data: { ...input, projectId: req.params.projectId },
        });
      } catch (err) {
        if ((err as { code?: string }).code === 'P2002') {
          return reply.status(409).send({ error: 'Валюта с таким кодом уже существует' });
        }
        throw err;
      }
      return reply.status(201).send({ currency });
    },
  );

  app.patch<{ Params: { projectId: string; currencyId: string } }>(
    '/api/projects/:projectId/economy/currencies/:currencyId',
    async (req, reply) => {
      app.requireAuth(req);
      if (!(await assertProjectOwnership(req.params.projectId, req.user!.id))) {
        return reply.status(404).send({ error: 'Project not found' });
      }
      const input = currencySchema.omit({ code: true }).partial().parse(req.body);
      if (Object.keys(input).length === 0) {
        return reply.status(400).send({ error: 'Нечего сохранять' });
      }
      const result = await prisma.currency.updateMany({
        where: { id: req.params.currencyId, projectId: req.params.projectId },
        data: input,
      });
      if (result.count === 0) return reply.status(404).send({ error: 'Валюта не найдена' });
      const currency = await prisma.currency.findFirst({
        where: { id: req.params.currencyId, projectId: req.params.projectId },
        include: { _count: { select: { resources: true } } },
      });
      return { currency };
    },
  );

  app.delete<{ Params: { projectId: string; currencyId: string } }>(
    '/api/projects/:projectId/economy/currencies/:currencyId',
    async (req, reply) => {
      app.requireAuth(req);
      if (!(await assertProjectOwnership(req.params.projectId, req.user!.id))) {
        return reply.status(404).send({ error: 'Project not found' });
      }
      const result = await prisma.currency.deleteMany({
        where: { id: req.params.currencyId, projectId: req.params.projectId },
      });
      if (!result.count) return reply.status(404).send({ error: 'Currency not found' });
      return reply.status(204).send();
    },
  );

  // === Resources ===
  app.get<{ Params: { projectId: string } }>(
    '/api/projects/:projectId/economy/resources',
    async (req, reply) => {
      app.requireAuth(req);
      if (!(await assertProjectOwnership(req.params.projectId, req.user!.id))) {
        return reply.status(404).send({ error: 'Project not found' });
      }
      const resources = await prisma.resource.findMany({
        where: { projectId: req.params.projectId },
        include: { currency: { select: { id: true, code: true, symbol: true } } },
        orderBy: [{ category: 'asc' }, { name: 'asc' }],
      });
      return { resources };
    },
  );

  app.post<{ Params: { projectId: string } }>(
    '/api/projects/:projectId/economy/resources',
    async (req, reply) => {
      app.requireAuth(req);
      if (!(await assertProjectOwnership(req.params.projectId, req.user!.id))) {
        return reply.status(404).send({ error: 'Project not found' });
      }
      const input = resourceSchema.parse(req.body);
      let resource;
      try {
        resource = await prisma.resource.create({
          data: { ...input, projectId: req.params.projectId },
          include: { currency: { select: { id: true, code: true, symbol: true } } },
        });
      } catch (err) {
        if ((err as { code?: string }).code === 'P2002') {
          return reply.status(409).send({ error: 'Ресурс с таким названием уже существует' });
        }
        throw err;
      }
      return reply.status(201).send({ resource });
    },
  );

  app.patch<{ Params: { projectId: string; resourceId: string } }>(
    '/api/projects/:projectId/economy/resources/:resourceId',
    async (req, reply) => {
      app.requireAuth(req);
      if (!(await assertProjectOwnership(req.params.projectId, req.user!.id))) {
        return reply.status(404).send({ error: 'Project not found' });
      }
      const input = z.object({
        name: z.string().trim().min(1).max(200).optional(),
        category: z.enum(['mineral', 'food', 'magic', 'technology', 'material', 'other']).optional(),
        rarity: z.enum(['common', 'uncommon', 'rare', 'legendary']).optional(),
        description: z.string().max(2000).nullable().optional(),
        unit: z.string().max(20).optional(),
        basePrice: z.number().positive().nullable().optional(),
        currencyId: z.string().nullable().optional(),
      }).parse(req.body);
      if (Object.keys(input).length === 0) {
        return reply.status(400).send({ error: 'Нечего сохранять' });
      }
      if (input.currencyId) {
        const currency = await prisma.currency.findFirst({
          where: { id: input.currencyId, projectId: req.params.projectId },
        });
        if (!currency) return reply.status(400).send({ error: 'Валюта не найдена' });
      }
      let resource;
      try {
        const result = await prisma.resource.updateMany({
          where: { id: req.params.resourceId, projectId: req.params.projectId },
          data: input,
        });
        if (result.count === 0) return reply.status(404).send({ error: 'Ресурс не найден' });
        resource = await prisma.resource.findFirst({
          where: { id: req.params.resourceId, projectId: req.params.projectId },
          include: { currency: { select: { id: true, code: true, symbol: true } } },
        });
      } catch (err) {
        if ((err as { code?: string }).code === 'P2002') {
          return reply.status(409).send({ error: 'Ресурс с таким названием уже существует' });
        }
        throw err;
      }
      return { resource };
    },
  );

  app.delete<{ Params: { projectId: string; resourceId: string } }>(
    '/api/projects/:projectId/economy/resources/:resourceId',
    async (req, reply) => {
      app.requireAuth(req);
      if (!(await assertProjectOwnership(req.params.projectId, req.user!.id))) {
        return reply.status(404).send({ error: 'Project not found' });
      }
      const result = await prisma.resource.deleteMany({
        where: { id: req.params.resourceId, projectId: req.params.projectId },
      });
      if (!result.count) return reply.status(404).send({ error: 'Resource not found' });
      return reply.status(204).send();
    },
  );

  // === Trade Routes ===
  app.get<{ Params: { projectId: string } }>(
    '/api/projects/:projectId/economy/trade-routes',
    async (req, reply) => {
      app.requireAuth(req);
      if (!(await assertProjectOwnership(req.params.projectId, req.user!.id))) {
        return reply.status(404).send({ error: 'Project not found' });
      }
      const routes = await prisma.tradeRoute.findMany({
        where: {
          projectId: req.params.projectId,
          AND: [
            { OR: [{ fromLocationId: null }, { fromLocation: { projectId: req.params.projectId } }] },
            { OR: [{ toLocationId: null }, { toLocation: { projectId: req.params.projectId } }] },
          ],
        },
        include: {
          fromLocation: { select: { id: true, name: true } },
          toLocation: { select: { id: true, name: true } },
        },
      });
      return { tradeRoutes: routes };
    },
  );

  app.post<{ Params: { projectId: string } }>(
    '/api/projects/:projectId/economy/trade-routes',
    async (req, reply) => {
      app.requireAuth(req);
      if (!(await assertProjectOwnership(req.params.projectId, req.user!.id))) {
        return reply.status(404).send({ error: 'Project not found' });
      }
      const input = tradeRouteSchema.parse(req.body);
      const locationIds = [...new Set([input.fromLocationId, input.toLocationId].filter((id): id is string => id != null))];
      if (locationIds.length && await prisma.location.count({
        where: { id: { in: locationIds }, projectId: req.params.projectId },
      }) !== locationIds.length) {
        return reply.status(404).send({ error: 'Локация не найдена' });
      }
      const route = await prisma.tradeRoute.create({
        data: { ...input, projectId: req.params.projectId },
        include: {
          fromLocation: { select: { id: true, name: true } },
          toLocation: { select: { id: true, name: true } },
        },
      });
      return reply.status(201).send({ tradeRoute: route });
    },
  );

  app.patch<{ Params: { projectId: string; routeId: string } }>(
    '/api/projects/:projectId/economy/trade-routes/:routeId',
    async (req, reply) => {
      app.requireAuth(req);
      if (!(await assertProjectOwnership(req.params.projectId, req.user!.id))) {
        return reply.status(404).send({ error: 'Project not found' });
      }
      const input = z.object({
        name: z.string().trim().min(1).max(200).optional(),
        fromLocationId: z.string().nullable().optional(),
        toLocationId: z.string().nullable().optional(),
        distanceKm: z.number().positive().nullable().optional(),
        travelDays: z.number().int().positive().nullable().optional(),
        danger: z.enum(['low', 'medium', 'high', 'extreme']).optional(),
        description: z.string().max(2000).nullable().optional(),
      }).parse(req.body);
      if (Object.keys(input).length === 0) {
        return reply.status(400).send({ error: 'Нечего сохранять' });
      }
      if (input.fromLocationId && input.toLocationId && input.fromLocationId === input.toLocationId) {
        return reply.status(400).send({ error: 'Откуда и куда должны различаться' });
      }
      const locationIds = [...new Set([input.fromLocationId, input.toLocationId].filter((id): id is string => id != null))];
      if (locationIds.length && await prisma.location.count({
        where: { id: { in: locationIds }, projectId: req.params.projectId },
      }) !== locationIds.length) {
        return reply.status(404).send({ error: 'Локация не найдена' });
      }
      const result = await prisma.tradeRoute.updateMany({
        where: { id: req.params.routeId, projectId: req.params.projectId },
        data: input,
      });
      if (result.count === 0) return reply.status(404).send({ error: 'Торговый путь не найден' });
      const tradeRoute = await prisma.tradeRoute.findFirst({
        where: { id: req.params.routeId, projectId: req.params.projectId },
        include: {
          fromLocation: { select: { id: true, name: true } },
          toLocation: { select: { id: true, name: true } },
        },
      });
      return { tradeRoute };
    },
  );

  app.delete<{ Params: { projectId: string; routeId: string } }>(
    '/api/projects/:projectId/economy/trade-routes/:routeId',
    async (req, reply) => {
      app.requireAuth(req);
      if (!(await assertProjectOwnership(req.params.projectId, req.user!.id))) {
        return reply.status(404).send({ error: 'Project not found' });
      }
      const result = await prisma.tradeRoute.deleteMany({
        where: { id: req.params.routeId, projectId: req.params.projectId },
      });
      if (!result.count) return reply.status(404).send({ error: 'Trade route not found' });
      return reply.status(204).send();
    },
  );
}
