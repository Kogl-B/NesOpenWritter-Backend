import type { FastifyPluginAsync } from 'fastify';

import { Prisma } from '@prisma/client';
import { z } from 'zod';

import { prisma } from '../lib/prisma.js';
import { assertProjectOwnership, getProjectAccess, toJson } from '../lib/access.js';
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
          gender: string | null;
          status: string | null; portraitPath: string | null;
          updatedAt: Date;
          metadata: unknown;
        }>
      >(Prisma.sql`
        SELECT id, name, "shortName", faction, gender, status,
               "portraitPath", "updatedAt", metadata
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
          gender: input.gender ?? null,
          status: input.status ?? 'alive',
          dateOfBirth: input.dateOfBirth || null,
          dateOfDeath: input.dateOfDeath || null,
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
          ...(input.gender !== undefined && { gender: input.gender }),
          ...(input.status !== undefined && { status: input.status }),
          ...(input.dateOfBirth !== undefined && { dateOfBirth: input.dateOfBirth || null }),
          ...(input.dateOfDeath !== undefined && { dateOfDeath: input.dateOfDeath || null }),
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

  // Хронология персонажа: главы, где он упомянут, и события, в которых участвует.
  app.get<{ Params: CharacterParam }>(
    '/api/projects/:projectId/characters/:characterId/storyline',
    async (req, reply) => {
      if (!(await assertProjectOwnership(req.params.projectId, req.user!.id))) {
        return reply.status(404).send({ error: 'Project not found' });
      }
      const character = await prisma.character.findFirst({
        where: { id: req.params.characterId, projectId: req.params.projectId },
        select: { id: true, status: true, dateOfDeath: true },
      });
      if (!character) return reply.status(404).send({ error: 'Character not found' });

      const [mentions, links] = await Promise.all([
        prisma.sceneMention.findMany({
          where: {
            entityType: 'character',
            entityId: character.id,
            scene: { projectId: req.params.projectId },
          },
          include: {
            scene: {
              select: {
                id: true,
                title: true,
                kind: true,
                orderIndex: true,
                parent: { select: { id: true, title: true, kind: true, orderIndex: true } },
              },
            },
          },
        }),
        prisma.eventCharacter.findMany({
          where: { characterId: character.id, event: { projectId: req.params.projectId } },
          include: {
            event: { select: { id: true, name: true, at: true, atNumeric: true } },
          },
        }),
      ]);

      const chapters = new Map<string, { id: string; title: string; order: number; scenes: string[] }>();
      for (const mention of mentions) {
        const scene = mention.scene;
        const chapter = scene.parent?.kind === 'chapter' ? scene.parent : scene;
        const hit = chapters.get(chapter.id) ?? {
          id: chapter.id,
          title: chapter.title,
          order: chapter.orderIndex,
          scenes: [],
        };
        if (scene.id !== chapter.id && !hit.scenes.includes(scene.title)) hit.scenes.push(scene.title);
        chapters.set(chapter.id, hit);
      }
      const ordered = [...chapters.values()].sort((a, b) => a.order - b.order || a.title.localeCompare(b.title, 'ru'));
      const beats: Array<{
        id: string;
        kind: 'appear' | 'present' | 'death' | 'event';
        title: string;
        detail: string | null;
        at: string | null;
        order: number;
      }> = ordered.map((chapter, index) => {
        const diedHere = character.status === 'dead' && index === ordered.length - 1;
        const kind = index === 0 ? 'appear' : diedHere ? 'death' : 'present';
        const title = kind === 'appear'
          ? `Появился в «${chapter.title}»`
          : kind === 'death'
            ? `Погиб в «${chapter.title}»`
            : `Был в «${chapter.title}»`;
        return {
          id: `chapter:${chapter.id}`,
          kind,
          title,
          detail: [chapter.scenes.join(', '), diedHere ? character.dateOfDeath : null].filter(Boolean).join(' · ') || null,
          at: null,
          order: chapter.order,
        };
      });

      if (character.status === 'dead' && !beats.some((b) => b.kind === 'death')) {
        beats.push({
          id: 'death',
          kind: 'death',
          title: 'Погиб',
          detail: character.dateOfDeath,
          at: character.dateOfDeath,
          order: 1_000_000,
        });
      }

      for (const link of links) {
        beats.push({
          id: `event:${link.event.id}`,
          kind: 'event',
          title: link.event.name,
          detail: link.role && link.role !== 'participant' ? link.role : null,
          at: link.event.at,
          order: (link.event.atNumeric ?? 500_000) + 0.5,
        });
      }
      beats.sort((a, b) => a.order - b.order || a.title.localeCompare(b.title, 'ru'));
      return { beats };
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

  const bondBody = z.object({
    characters: z.array(z.object({
      fromId: z.string().min(1),
      toId: z.string().min(1),
      name: z.string().trim().min(1).max(50),
    })).max(100),
    items: z.array(z.object({
      leftId: z.string().min(1),
      rightId: z.string().min(1),
      name: z.string().trim().min(1).max(80),
    })).max(100),
  });

  app.put<{ Params: { projectId: string; chapterId: string } }>(
    '/api/projects/:projectId/chapters/:chapterId/bonds',
    async (req, reply) => {
      const role = await getProjectAccess(req.params.projectId, req.user!.id);
      if (!role) return reply.status(404).send({ error: 'Project not found' });
      if (role === 'viewer') return reply.status(403).send({ error: 'Недостаточно прав' });
      const input = bondBody.parse(req.body);
      const chapter = await prisma.chapter.findFirst({
        where: { id: req.params.chapterId, projectId: req.params.projectId },
        select: { id: true },
      });
      if (!chapter) return reply.status(404).send({ error: 'Сцена не найдена' });
      const marker = `openwritter:scene:${chapter.id}`;

      const characters = input.characters.filter((row) => row.fromId !== row.toId);
      const items = input.items.filter((row) => row.leftId !== row.rightId);
      const characterIds = [...new Set(characters.flatMap((row) => [row.fromId, row.toId]))];
      const itemIds = [...new Set(items.flatMap((row) => [row.leftId, row.rightId]))];
      const [knownCharacters, knownItems] = await Promise.all([
        characterIds.length
          ? prisma.character.findMany({ where: { projectId: req.params.projectId, id: { in: characterIds } }, select: { id: true } })
          : [],
        itemIds.length
          ? prisma.item.findMany({ where: { projectId: req.params.projectId, id: { in: itemIds } }, select: { id: true } })
          : [],
      ]);
      const okCharacters = new Set(knownCharacters.map((row) => row.id));
      const okItems = new Set(knownItems.map((row) => row.id));

      await prisma.$transaction(async (tx) => {
        await tx.characterRelation.deleteMany({ where: { projectId: req.params.projectId, description: marker } });
        const seen = new Set<string>();
        for (const row of characters) {
          if (!okCharacters.has(row.fromId) || !okCharacters.has(row.toId)) continue;
          const key = `${row.fromId}:${row.toId}:${row.name.toLocaleLowerCase('ru-RU')}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const manual = await tx.characterRelation.findFirst({
            where: { fromCharacterId: row.fromId, toCharacterId: row.toId, relationType: row.name },
            select: { id: true },
          });
          if (manual) continue;
          await tx.characterRelation.create({
            data: {
              projectId: req.params.projectId,
              fromCharacterId: row.fromId,
              toCharacterId: row.toId,
              relationType: row.name,
              strength: 50,
              description: marker,
            },
          });
        }

        const catalog = await tx.item.findMany({
          where: { projectId: req.params.projectId },
          select: { id: true, name: true, metadata: true },
        });
        const byName = new Map(catalog.map((row) => [row.name.toLocaleLowerCase('ru-RU'), row]));
        const kept = new Set<string>();
        for (const row of items) {
          if (!okItems.has(row.leftId) || !okItems.has(row.rightId)) continue;
          const current = byName.get(row.name.toLocaleLowerCase('ru-RU'));
          const madeFrom = [row.leftId, row.rightId];
          if (current) {
            const meta = current.metadata && typeof current.metadata === 'object' && !Array.isArray(current.metadata)
              ? { ...(current.metadata as Record<string, unknown>) }
              : {};
            await tx.item.update({
              where: { id: current.id },
              data: { metadata: toJson({ ...meta, madeFrom, madeInChapter: chapter.id, source: 'manuscript', bond: row.name }) },
            });
            kept.add(current.id);
            continue;
          }
          const created = await tx.item.create({
            data: {
              projectId: req.params.projectId,
              name: row.name,
              category: 'other',
              metadata: toJson({ madeFrom, madeInChapter: chapter.id, source: 'manuscript', bond: row.name }),
            },
          });
          byName.set(row.name.toLocaleLowerCase('ru-RU'), { id: created.id, name: created.name, metadata: created.metadata });
          kept.add(created.id);
        }
        for (const row of catalog) {
          if (kept.has(row.id)) continue;
          const meta = row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata)
            ? { ...(row.metadata as Record<string, unknown>) }
            : null;
          if (!meta || meta.source !== 'manuscript' || meta.madeInChapter !== chapter.id) continue;
          const { madeFrom: _from, madeInChapter: _chapter, source: _source, bond: _bond, ...rest } = meta;
          await tx.item.update({ where: { id: row.id }, data: { metadata: toJson(rest) } });
        }
      });
      return { ok: true };
    },
  );
};
