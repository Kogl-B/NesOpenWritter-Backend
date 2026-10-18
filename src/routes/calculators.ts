import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { assertProjectOwnership, getProjectAccess } from '../lib/access.js';

const DEFAULTS = [
  { key: 'zm', name: 'Золотые монеты', kind: 'money', unit: 'зм' },
  { key: 'sm', name: 'Серебряные монеты', kind: 'money', unit: 'см' },
  { key: 'mm', name: 'Медные монеты', kind: 'money', unit: 'мм' },
];

const keySchema = z.string().trim().min(1).max(16).regex(/^[\p{L}\p{N}_]+$/u, 'Код: буквы, цифры и _');

const createSchema = z.object({
  key: keySchema,
  name: z.string().trim().min(1).max(80),
  kind: z.enum(['money', 'item']).default('money'),
  unit: z.string().trim().max(16).optional().nullable(),
});

const entrySchema = z.object({
  characterId: z.string().min(1),
  calculatorId: z.string().min(1),
  delta: z.number().finite(),
});

async function ensureDefaults(projectId: string) {
  const count = await prisma.calculator.count({ where: { projectId } });
  if (count > 0) return;
  await prisma.calculator.createMany({
    data: DEFAULTS.map((row) => ({ ...row, projectId })),
    skipDuplicates: true,
  });
}

export const calculatorRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', async (req) => {
    app.requireAuth(req);
  });

  app.get<{ Params: { projectId: string } }>(
    '/api/projects/:projectId/calculators',
    async (req, reply) => {
      if (!(await assertProjectOwnership(req.params.projectId, req.user!.id))) {
        return reply.status(404).send({ error: 'Project not found' });
      }
      await ensureDefaults(req.params.projectId);
      const calculators = await prisma.calculator.findMany({
        where: { projectId: req.params.projectId },
        orderBy: [{ kind: 'asc' }, { name: 'asc' }],
      });
      return { calculators };
    },
  );

  app.post<{ Params: { projectId: string } }>(
    '/api/projects/:projectId/calculators',
    async (req, reply) => {
      const role = await getProjectAccess(req.params.projectId, req.user!.id);
      if (!role) return reply.status(404).send({ error: 'Project not found' });
      if (role === 'viewer') return reply.status(403).send({ error: 'Недостаточно прав' });
      const input = createSchema.parse(req.body);
      try {
        const calculator = await prisma.calculator.create({
          data: {
            projectId: req.params.projectId,
            key: input.key.toLocaleLowerCase('ru-RU'),
            name: input.name,
            kind: input.kind,
            unit: input.unit ?? null,
          },
        });
        return reply.status(201).send({ calculator });
      } catch (err) {
        if ((err as { code?: string }).code === 'P2002') {
          return reply.status(409).send({ error: 'Калькулятор с таким кодом уже есть' });
        }
        throw err;
      }
    },
  );

  app.delete<{ Params: { projectId: string; calculatorId: string } }>(
    '/api/projects/:projectId/calculators/:calculatorId',
    async (req, reply) => {
      const role = await getProjectAccess(req.params.projectId, req.user!.id);
      if (!role) return reply.status(404).send({ error: 'Project not found' });
      if (role === 'viewer') return reply.status(403).send({ error: 'Недостаточно прав' });
      const result = await prisma.calculator.deleteMany({
        where: { id: req.params.calculatorId, projectId: req.params.projectId },
      });
      if (result.count === 0) return reply.status(404).send({ error: 'Калькулятор не найден' });
      return reply.status(204).send();
    },
  );

  app.get<{ Params: { projectId: string; characterId: string } }>(
    '/api/projects/:projectId/characters/:characterId/balances',
    async (req, reply) => {
      if (!(await assertProjectOwnership(req.params.projectId, req.user!.id))) {
        return reply.status(404).send({ error: 'Project not found' });
      }
      await ensureDefaults(req.params.projectId);
      const [calculators, sums, history] = await Promise.all([
        prisma.calculator.findMany({
          where: { projectId: req.params.projectId },
          orderBy: [{ kind: 'asc' }, { name: 'asc' }],
        }),
        prisma.characterLedger.groupBy({
          by: ['calculatorId'],
          where: { projectId: req.params.projectId, characterId: req.params.characterId },
          _sum: { delta: true },
        }),
        prisma.characterLedger.findMany({
          where: { projectId: req.params.projectId, characterId: req.params.characterId },
          orderBy: { createdAt: 'desc' },
          take: 30,
          include: {
            calculator: { select: { key: true, name: true, kind: true, unit: true } },
            chapter: { select: { title: true } },
          },
        }),
      ]);
      const byId = new Map(sums.map((row) => [row.calculatorId, row._sum.delta ?? 0]));
      return {
        balances: calculators.map((calc) => ({
          ...calc,
          balance: byId.get(calc.id) ?? 0,
        })),
        history: history.map((row) => ({
          id: row.id,
          delta: row.delta,
          note: row.note,
          createdAt: row.createdAt,
          chapterTitle: row.chapter?.title ?? null,
          calculator: row.calculator,
        })),
      };
    },
  );

  app.post<{ Params: { projectId: string; characterId: string } }>(
    '/api/projects/:projectId/characters/:characterId/ledger',
    async (req, reply) => {
      const role = await getProjectAccess(req.params.projectId, req.user!.id);
      if (!role) return reply.status(404).send({ error: 'Project not found' });
      if (role === 'viewer') return reply.status(403).send({ error: 'Недостаточно прав' });
      const input = z.object({
        calculatorId: z.string().min(1),
        delta: z.number().finite().refine((n) => n !== 0, 'Изменение не может быть нулём'),
        note: z.string().max(200).optional().nullable(),
      }).parse(req.body);
      const [character, calculator] = await Promise.all([
        prisma.character.findFirst({
          where: { id: req.params.characterId, projectId: req.params.projectId },
          select: { id: true },
        }),
        prisma.calculator.findFirst({
          where: { id: input.calculatorId, projectId: req.params.projectId },
          select: { id: true },
        }),
      ]);
      if (!character || !calculator) return reply.status(404).send({ error: 'Не найдено' });
      const entry = await prisma.characterLedger.create({
        data: {
          projectId: req.params.projectId,
          characterId: character.id,
          calculatorId: calculator.id,
          delta: input.delta,
          note: input.note ?? null,
        },
      });
      return reply.status(201).send({ entry });
    },
  );

  app.put<{ Params: { projectId: string; chapterId: string } }>(
    '/api/projects/:projectId/chapters/:chapterId/ledger',
    async (req, reply) => {
      const role = await getProjectAccess(req.params.projectId, req.user!.id);
      if (!role) return reply.status(404).send({ error: 'Project not found' });
      if (role === 'viewer') return reply.status(403).send({ error: 'Недостаточно прав' });
      const input = z.object({ entries: z.array(entrySchema).max(500) }).parse(req.body);
      const chapter = await prisma.chapter.findFirst({
        where: { id: req.params.chapterId, projectId: req.params.projectId },
        select: { id: true },
      });
      if (!chapter) return reply.status(404).send({ error: 'Сцена не найдена' });

      const characterIds = [...new Set(input.entries.map((e) => e.characterId))];
      const calculatorIds = [...new Set(input.entries.map((e) => e.calculatorId))];
      const [characters, calculators] = await Promise.all([
        characterIds.length
          ? prisma.character.findMany({
              where: { projectId: req.params.projectId, id: { in: characterIds } },
              select: { id: true },
            })
          : [],
        calculatorIds.length
          ? prisma.calculator.findMany({
              where: { projectId: req.params.projectId, id: { in: calculatorIds } },
              select: { id: true },
            })
          : [],
      ]);
      const okCharacters = new Set(characters.map((c) => c.id));
      const okCalculators = new Set(calculators.map((c) => c.id));
      const rows = input.entries.filter((e) => okCharacters.has(e.characterId) && okCalculators.has(e.calculatorId));

      await prisma.$transaction(async (tx) => {
        await tx.characterLedger.deleteMany({
          where: { projectId: req.params.projectId, chapterId: chapter.id },
        });
        if (rows.length === 0) return;
        await tx.characterLedger.createMany({
          data: rows.map((e) => ({
            projectId: req.params.projectId,
            characterId: e.characterId,
            calculatorId: e.calculatorId,
            chapterId: chapter.id,
            delta: e.delta,
          })),
        });
      });
      return { count: rows.length };
    },
  );
};
