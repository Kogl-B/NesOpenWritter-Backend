import type { FastifyPluginAsync } from 'fastify';

import { Prisma } from '@prisma/client';

import { prisma } from '../lib/prisma.js';
import { assertProjectOwnership, toJson } from '../lib/access.js';
import {
  characterCreateSchema,
  characterUpdateSchema,
  characterRelationCreateSchema,
  characterRelationUpdateSchema,
  genealogyCreateSchema,
} from '../lib/schemas.js';

type ProjectParam = { projectId: string };
type CharacterParam = { projectId: string; characterId: string };
type RelationParam = { projectId: string; relationId: string };
type GenealogyParam = { projectId: string; edgeId: string };

export const characterRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', async (req) => {
    app.requireAuth(req);
  });

  // ----- Character CRUD ----------------------------------------------------

  app.get<{ Params: ProjectParam }>(
    '/api/projects/:projectId/characters',
    async (req, reply) => {
      if (!(await assertProjectOwnership(req.params.projectId, req.user!.id))) {
        return reply.status(404).send({ error: 'Project not found' });
      }
      // Лёгкий список для сайдбара: biography/summary/traits не тянем —
      // полная запись приходит fetchOne при выборе персонажа. projectId/
      // createdAt не используются фронтом в списке. $queryRaw: материализация
      // 454 строк через движок Prisma ~17ms против ~2ms raw (см. chapters.ts).
      const characters = await prisma.$queryRaw<
        Array<{
          id: string; name: string;
          shortName: string | null; faction: string | null;
          status: string | null; portraitPath: string | null;
          updatedAt: Date;
        }>
      >(Prisma.sql`
        SELECT id, name, "shortName", faction, status,
               "portraitPath", "updatedAt"
        FROM characters
        WHERE "projectId" = ${req.params.projectId}
        ORDER BY "updatedAt" DESC
      `);
      return { characters };
    },
  );

  app.post<{ Params: ProjectParam }>(
    '/api/projects/:projectId/characters',
    async (req, reply) => {
      if (!(await assertProjectOwnership(req.params.projectId, req.user!.id))) {
        return reply.status(404).send({ error: 'Project not found' });
      }
      const input = characterCreateSchema.parse(req.body);
      const character = await prisma.character.create({
        data: {
          projectId: req.params.projectId,
          name: input.name,
          shortName: input.shortName ?? null,
          portraitPath: input.portraitPath ?? null,
          summary: input.summary ?? null,
          biography: input.biography ?? null,
          faction: input.faction ?? null,
          status: input.status ?? 'alive',
          dateOfBirth: input.dateOfBirth ?? null,
          dateOfDeath: input.dateOfDeath ?? null,
          traits: input.traits ?? [],
          abilities: input.abilities ?? [],
          metadata: toJson(input.metadata),
        },
      });
      return reply.status(201).send({ character });
    },
  );

  app.get<{ Params: CharacterParam }>(
    '/api/projects/:projectId/characters/:characterId',
    async (req, reply) => {
      if (!(await assertProjectOwnership(req.params.projectId, req.user!.id))) {
        return reply.status(404).send({ error: 'Project not found' });
      }
      const character = await prisma.character.findFirst({
        where: { id: req.params.characterId, projectId: req.params.projectId },
      });
      if (!character) return reply.status(404).send({ error: 'Character not found' });
      return { character };
    },
  );

  app.patch<{ Params: CharacterParam }>(
    '/api/projects/:projectId/characters/:characterId',
    async (req, reply) => {
      if (!(await assertProjectOwnership(req.params.projectId, req.user!.id))) {
        return reply.status(404).send({ error: 'Project not found' });
      }
      const input = characterUpdateSchema.parse(req.body);
      const result = await prisma.character.updateMany({
        where: { id: req.params.characterId, projectId: req.params.projectId },
        data: {
          ...(input.name !== undefined && { name: input.name }),
          ...(input.shortName !== undefined && { shortName: input.shortName }),
          ...(input.portraitPath !== undefined && { portraitPath: input.portraitPath }),
          ...(input.summary !== undefined && { summary: input.summary }),
          ...(input.biography !== undefined && { biography: input.biography }),
          ...(input.faction !== undefined && { faction: input.faction }),
          ...(input.status !== undefined && { status: input.status }),
          ...(input.dateOfBirth !== undefined && { dateOfBirth: input.dateOfBirth }),
          ...(input.dateOfDeath !== undefined && { dateOfDeath: input.dateOfDeath }),
          ...(input.traits !== undefined && { traits: input.traits }),
          ...(input.abilities !== undefined && { abilities: input.abilities }),
          ...(input.metadata !== undefined && { metadata: toJson(input.metadata) }),
        },
      });
      if (result.count === 0) return reply.status(404).send({ error: 'Character not found' });
      const character = await prisma.character.findUnique({
        where: { id: req.params.characterId },
      });
      return { character };
    },
  );

  app.delete<{ Params: CharacterParam }>(
    '/api/projects/:projectId/characters/:characterId',
    async (req, reply) => {
      if (!(await assertProjectOwnership(req.params.projectId, req.user!.id))) {
        return reply.status(404).send({ error: 'Project not found' });
      }
      const result = await prisma.character.deleteMany({
        where: { id: req.params.characterId, projectId: req.params.projectId },
      });
      if (result.count === 0) return reply.status(404).send({ error: 'Character not found' });
      return reply.status(204).send();
    },
  );

  // ----- Character relations -----------------------------------------------

  app.get<{ Params: ProjectParam }>(
    '/api/projects/:projectId/character-relations',
    async (req, reply) => {
      if (!(await assertProjectOwnership(req.params.projectId, req.user!.id))) {
        return reply.status(404).send({ error: 'Project not found' });
      }
      const relations = await prisma.characterRelation.findMany({
        where: { projectId: req.params.projectId },
        orderBy: { createdAt: 'asc' },
      });
      return { relations };
    },
  );

  app.post<{ Params: ProjectParam }>(
    '/api/projects/:projectId/character-relations',
    async (req, reply) => {
      if (!(await assertProjectOwnership(req.params.projectId, req.user!.id))) {
        return reply.status(404).send({ error: 'Project not found' });
      }
      const input = characterRelationCreateSchema.parse(req.body);
      // verify both characters belong to this project
      const count = await prisma.character.count({
        where: {
          projectId: req.params.projectId,
          id: { in: [input.fromCharacterId, input.toCharacterId] },
        },
      });
      if (count !== 2) {
        return reply.status(400).send({ error: 'Оба персонажа должны принадлежать проекту' });
      }
      if (input.fromCharacterId === input.toCharacterId) {
        return reply.status(400).send({ error: 'Нельзя связать персонажа с самим собой' });
      }
      let relation;
      try {
        relation = await prisma.characterRelation.create({
          data: {
            projectId: req.params.projectId,
            fromCharacterId: input.fromCharacterId,
            toCharacterId: input.toCharacterId,
            relationType: input.relationType,
            strength: input.strength ?? 50,
            description: input.description ?? null,
          },
        });
      } catch (err) {
        if ((err as { code?: string }).code === 'P2002') {
          return reply.status(409).send({ error: 'Такая связь уже существует' });
        }
        throw err;
      }
      return reply.status(201).send({ relation });
    },
  );

  app.patch<{ Params: RelationParam }>(
    '/api/projects/:projectId/character-relations/:relationId',
    async (req, reply) => {
      if (!(await assertProjectOwnership(req.params.projectId, req.user!.id))) {
        return reply.status(404).send({ error: 'Project not found' });
      }
      const input = characterRelationUpdateSchema.parse(req.body);
      const result = await prisma.characterRelation.updateMany({
        where: { id: req.params.relationId, projectId: req.params.projectId },
        data: {
          ...(input.relationType !== undefined && { relationType: input.relationType }),
          ...(input.strength !== undefined && { strength: input.strength }),
          ...(input.description !== undefined && { description: input.description }),
        },
      });
      if (result.count === 0) return reply.status(404).send({ error: 'Relation not found' });
      const relation = await prisma.characterRelation.findUnique({
        where: { id: req.params.relationId },
      });
      return { relation };
    },
  );

  app.delete<{ Params: RelationParam }>(
    '/api/projects/:projectId/character-relations/:relationId',
    async (req, reply) => {
      if (!(await assertProjectOwnership(req.params.projectId, req.user!.id))) {
        return reply.status(404).send({ error: 'Project not found' });
      }
      const result = await prisma.characterRelation.deleteMany({
        where: { id: req.params.relationId, projectId: req.params.projectId },
      });
      if (result.count === 0) return reply.status(404).send({ error: 'Relation not found' });
      return reply.status(204).send();
    },
  );

  // ----- Genealogy ---------------------------------------------------------

  app.get<{ Params: ProjectParam }>(
    '/api/projects/:projectId/genealogy',
    async (req, reply) => {
      if (!(await assertProjectOwnership(req.params.projectId, req.user!.id))) {
        return reply.status(404).send({ error: 'Project not found' });
      }
      const edges = await prisma.genealogyEdge.findMany({
        where: { projectId: req.params.projectId },
        orderBy: { createdAt: 'asc' },
      });
      return { edges };
    },
  );

  app.post<{ Params: ProjectParam }>(
    '/api/projects/:projectId/genealogy',
    async (req, reply) => {
      if (!(await assertProjectOwnership(req.params.projectId, req.user!.id))) {
        return reply.status(404).send({ error: 'Project not found' });
      }
      const input = genealogyCreateSchema.parse(req.body);
      if (input.parentId === input.childId) {
        return reply.status(400).send({ error: 'Персонаж не может быть родителем самому себе' });
      }
      const count = await prisma.character.count({
        where: {
          projectId: req.params.projectId,
          id: { in: [input.parentId, input.childId] },
        },
      });
      if (count !== 2) {
        return reply.status(400).send({ error: 'Оба персонажа должны принадлежать проекту' });
      }
      // Цикл: если «ребёнок» уже является предком «родителя», дерево сломается.
      const existingEdges = await prisma.genealogyEdge.findMany({
        where: { projectId: req.params.projectId },
        select: { parentId: true, childId: true },
      });
      const childrenOf = new Map<string, string[]>();
      for (const e of existingEdges) {
        if (!childrenOf.has(e.parentId)) childrenOf.set(e.parentId, []);
        childrenOf.get(e.parentId)!.push(e.childId);
      }
      const seen = new Set<string>([input.childId]);
      const queue = [input.childId];
      while (queue.length > 0) {
        const cur = queue.shift()!;
        for (const child of childrenOf.get(cur) ?? []) {
          if (child === input.parentId) {
            return reply.status(400).send({ error: 'Эта связь создаст цикл в родословной' });
          }
          if (!seen.has(child)) {
            seen.add(child);
            queue.push(child);
          }
        }
      }
      let edge;
      try {
        edge = await prisma.genealogyEdge.create({
          data: {
            projectId: req.params.projectId,
            parentId: input.parentId,
            childId: input.childId,
            kind: input.kind ?? 'biological',
          },
        });
      } catch (err) {
        if ((err as { code?: string }).code === 'P2002') {
          return reply.status(409).send({ error: 'Такая родственная связь уже существует' });
        }
        throw err;
      }
      return reply.status(201).send({ edge });
    },
  );

  app.delete<{ Params: GenealogyParam }>(
    '/api/projects/:projectId/genealogy/:edgeId',
    async (req, reply) => {
      if (!(await assertProjectOwnership(req.params.projectId, req.user!.id))) {
        return reply.status(404).send({ error: 'Project not found' });
      }
      const result = await prisma.genealogyEdge.deleteMany({
        where: { id: req.params.edgeId, projectId: req.params.projectId },
      });
      if (result.count === 0) return reply.status(404).send({ error: 'Edge not found' });
      return reply.status(204).send();
    },
  );

  // ----- Character positions ----------------------------------------------

  app.get<{ Params: ProjectParam }>(
    '/api/projects/:projectId/character-positions',
    async (req, reply) => {
      if (!(await assertProjectOwnership(req.params.projectId, req.user!.id))) {
        return reply.status(404).send({ error: 'Project not found' });
      }
      const positions = await prisma.characterPosition.findMany({
        where: { projectId: req.params.projectId },
        orderBy: { createdAt: 'asc' },
      });
      return { positions };
    },
  );
};
