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
});

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
      const currency = await prisma.currency.create({
        data: { ...input, projectId: req.params.projectId },
      });
      return reply.status(201).send({ currency });
    },
  );

  app.delete<{ Params: { projectId: string; currencyId: string } }>(
    '/api/projects/:projectId/economy/currencies/:currencyId',
    async (req, reply) => {
      app.requireAuth(req);
      if (!(await assertProjectOwnership(req.params.projectId, req.user!.id))) {
        return reply.status(404).send({ error: 'Project not found' });
      }
      try {
        await prisma.currency.delete({ where: { id: req.params.currencyId } });
        return reply.status(204).send();
      } catch {
        return reply.status(404).send({ error: 'Currency not found' });
      }
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
        include: { currency: { select: { code: true, symbol: true } } },
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
      const resource = await prisma.resource.create({
        data: { ...input, projectId: req.params.projectId },
        include: { currency: { select: { code: true, symbol: true } } },
      });
      return reply.status(201).send({ resource });
    },
  );

  app.delete<{ Params: { projectId: string; resourceId: string } }>(
    '/api/projects/:projectId/economy/resources/:resourceId',
    async (req, reply) => {
      app.requireAuth(req);
      if (!(await assertProjectOwnership(req.params.projectId, req.user!.id))) {
        return reply.status(404).send({ error: 'Project not found' });
      }
      try {
        await prisma.resource.delete({ where: { id: req.params.resourceId } });
        return reply.status(204).send();
      } catch {
        return reply.status(404).send({ error: 'Resource not found' });
      }
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
        where: { projectId: req.params.projectId },
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

  app.delete<{ Params: { projectId: string; routeId: string } }>(
    '/api/projects/:projectId/economy/trade-routes/:routeId',
    async (req, reply) => {
      app.requireAuth(req);
      if (!(await assertProjectOwnership(req.params.projectId, req.user!.id))) {
        return reply.status(404).send({ error: 'Project not found' });
      }
      try {
        await prisma.tradeRoute.delete({ where: { id: req.params.routeId } });
        return reply.status(204).send();
      } catch {
        return reply.status(404).send({ error: 'Trade route not found' });
      }
    },
  );
}
