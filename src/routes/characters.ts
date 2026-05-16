import type { FastifyPluginAsync } from 'fastify';

import type { Prisma } from '@prisma/client';

import { prisma } from '../lib/prisma.js';
import { characterCreateSchema, characterUpdateSchema } from '../lib/schemas.js';

const toJson = (v: Record<string, unknown> | undefined): Prisma.InputJsonValue =>
  (v ?? {}) as Prisma.InputJsonValue;

type ProjectParam = { projectId: string };
type CharacterParam = { projectId: string; characterId: string };

async function assertProjectOwnership(
  projectId: string,
  userId: string,
): Promise<boolean> {
  const project = await prisma.project.findFirst({
    where: { id: projectId, ownerId: userId },
    select: { id: true },
  });
  return project !== null;
}

export const characterRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', async (req) => {
    app.requireAuth(req);
  });

  app.get<{ Params: ProjectParam }>(
    '/api/projects/:projectId/characters',
    async (req, reply) => {
      const owns = await assertProjectOwnership(req.params.projectId, req.user!.id);
      if (!owns) return reply.status(404).send({ error: 'Project not found' });

      const characters = await prisma.character.findMany({
        where: { projectId: req.params.projectId },
        orderBy: { updatedAt: 'desc' },
      });
      return { characters };
    },
  );

  app.post<{ Params: ProjectParam }>(
    '/api/projects/:projectId/characters',
    async (req, reply) => {
      const owns = await assertProjectOwnership(req.params.projectId, req.user!.id);
      if (!owns) return reply.status(404).send({ error: 'Project not found' });

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
      const owns = await assertProjectOwnership(req.params.projectId, req.user!.id);
      if (!owns) return reply.status(404).send({ error: 'Project not found' });

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
      const owns = await assertProjectOwnership(req.params.projectId, req.user!.id);
      if (!owns) return reply.status(404).send({ error: 'Project not found' });

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
      const owns = await assertProjectOwnership(req.params.projectId, req.user!.id);
      if (!owns) return reply.status(404).send({ error: 'Project not found' });

      const result = await prisma.character.deleteMany({
        where: { id: req.params.characterId, projectId: req.params.projectId },
      });
      if (result.count === 0) return reply.status(404).send({ error: 'Character not found' });
      return reply.status(204).send();
    },
  );
};
