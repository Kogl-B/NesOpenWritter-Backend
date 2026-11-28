import { Prisma } from '@prisma/client';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import { getProjectAccess } from '../lib/access.js';
import { AiHttpError } from '../lib/ai/aiError.js';
import { prisma } from '../lib/prisma.js';
import { resolveTimelineDate } from '../lib/timeline/date.js';
import { timelineInput } from '../lib/timeline/extraction.js';
import { proposalsSchema, timelineName } from '../lib/timeline/proposals.js';
import { isTimelineReady, TIMELINE_PUBLICATION_REQUIRED } from '../lib/timeline/publication.js';
import { scheduleTimelineAnalysis } from '../lib/timeline/schedule.js';

type ProjectParams = { projectId: string };
type ProposalParams = ProjectParams & { jobId: string; index: string };
const chapterSchema = z.object({ chapterId: z.string().min(1).max(40) });
const decisionSchema = z.discriminatedUnion('disposition', [
  z.object({ disposition: z.literal('dismissed') }),
  z.object({
    disposition: z.literal('accepted'),
    eventId: z.string().min(1).max(40).optional(),
    updateDate: z.boolean().optional(),
    expectedAt: z.string().min(1).max(160).optional(),
    name: z.string().trim().min(1).max(160).optional(),
    at: z.string().trim().max(160).optional(),
  }),
]);

function isEditor(role: Awaited<ReturnType<typeof getProjectAccess>>): boolean {
  return role !== null && role !== 'viewer';
}

export const timelineAnalysisRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', async (req) => app.requireAuth(req));

  app.get<{ Params: ProjectParams }>('/api/projects/:projectId/timeline-analysis', async (req, reply) => {
    const { projectId } = req.params;
    if (!isEditor(await getProjectAccess(projectId, req.user!.id))) {
      return reply.status(404).send({ error: 'Книга не найдена' });
    }
    const { chapterId } = chapterSchema.parse(req.query);
    const input = await timelineInput(prisma, projectId, chapterId);
    if (!input) return reply.status(404).send({ error: 'Сцена не найдена' });
    const fields = {
      id: true, status: true, error: true, result: true,
      timelineReviews: {
        select: {
          proposalIndex: true, disposition: true, eventId: true,
          event: { select: { at: true, atNumeric: true } },
        },
      },
    } as const;
    const current = await prisma.aiJob.findUnique({
      where: { timelineKey: `${chapterId}:${input.version}` },
      select: fields,
    });
    const job = current ?? await prisma.aiJob.findFirst({
      where: { projectId, timelineChapterId: chapterId, kind: 'timeline' },
      orderBy: { createdAt: 'desc' },
      select: fields,
    });
    if (!job) return { job: null };
    const suggestions = proposalsSchema.safeParse(job.result);
    const proposals = suggestions.success ? suggestions.data.proposals : [];
    const decisions = new Map(job.timelineReviews.map((row) => [row.proposalIndex, row]));
    const referenceIds = current ? proposals.flatMap(({ relativeToEventId }, index) =>
      relativeToEventId && !decisions.has(index) ? [relativeToEventId] : []) : [];
    const references = referenceIds.length ? await prisma.timelineEvent.findMany({
      where: { projectId: input.worldId, id: { in: referenceIds } }, select: { id: true, at: true },
    }) : [];
    const referenceDates = new Map(references.map(({ id, at }) => [id, at]));
    return {
      job: {
        id: job.id,
        status: job.status,
        stale: current === null,
        error: job.error,
        proposals: proposals.map((proposal, index) => {
          const review = decisions.get(index);
          let date = { at: proposal.at, atNumeric: proposal.atNumeric, date: proposal.knownDate };
          if (review?.event) {
            const { at, atNumeric } = review.event;
            date = { at, atNumeric, date: atNumeric === null ? null : at };
          } else if (current && !review && proposal.relativeToEventId) {
            date = resolveTimelineDate(
              proposal.dateText, input.settings.start, proposal.anchorText, input.calendar ?? undefined,
              referenceDates.get(proposal.relativeToEventId) ?? null,
            );
          }
          return {
            ...proposal, index, at: date.at, atNumeric: date.atNumeric, knownDate: date.date,
            decision: review ? { proposalIndex: index, disposition: review.disposition, eventId: review.eventId } : null,
          };
        }),
      },
    };
  });

  app.post<{ Params: ProjectParams }>('/api/projects/:projectId/timeline-analysis', async (req, reply) => {
    const { projectId } = req.params;
    if (!isEditor(await getProjectAccess(projectId, req.user!.id))) {
      return reply.status(404).send({ error: 'Книга не найдена' });
    }
    const { chapterId } = chapterSchema.parse(req.body);
    try {
      const job = await scheduleTimelineAnalysis({ userId: req.user!.id, projectId, chapterId, automatic: false });
      if (!job) return reply.status(404).send({ error: 'Сцена не найдена' });
      return reply.status(202).send({ job });
    } catch (error) {
      if (error instanceof AiHttpError) return reply.status(error.statusCode).send({ error: error.message });
      throw error;
    }
  });

  app.post<{ Params: ProposalParams }>('/api/projects/:projectId/timeline-analysis/:jobId/proposals/:index', async (req, reply) => {
    const { projectId, jobId } = req.params;
    if (!isEditor(await getProjectAccess(projectId, req.user!.id))) {
      return reply.status(404).send({ error: 'Книга не найдена' });
    }
    const index = z.coerce.number().int().min(0).parse(req.params.index);
    const decision = decisionSchema.parse(req.body);
    try {
      const result = await prisma.$transaction(async (tx) => {
        // Общая для разбора блокировка сериализует подтверждения, включая два
        // предложения одного события из разных сцен.
        await tx.$queryRaw`
          SELECT id FROM projects
          WHERE id = COALESCE((SELECT "universeId" FROM projects WHERE id = ${projectId}), ${projectId})
          FOR UPDATE
        `;
        const job = await tx.aiJob.findFirst({
          where: { id: jobId, projectId, kind: 'timeline', status: 'done' },
          select: { timelineChapterId: true, timelineKey: true, result: true },
        });
        if (!job?.timelineChapterId) throw new AiHttpError(404, 'Разбор не найден.');
        const parsed = proposalsSchema.safeParse(job.result);
        const proposal = parsed.success && parsed.data.proposals[index];
        if (!proposal) throw new AiHttpError(404, 'Предложение не найдено.');

        const review = await tx.timelineReview.findUnique({ where: { jobId_proposalIndex: { jobId, proposalIndex: index } } });
        if (review) {
          if (review.disposition !== decision.disposition) throw new AiHttpError(409, 'По предложению уже принято решение.');
          return review;
        }

        await tx.$queryRaw`SELECT id FROM chapters WHERE id = ${job.timelineChapterId} AND "projectId" = ${projectId} FOR UPDATE`;
        const input = await timelineInput(tx, projectId, job.timelineChapterId);
        if (!input || job.timelineKey !== `${job.timelineChapterId}:${input.version}`) {
          throw new AiHttpError(409, 'Сцена или точка отсчёта изменились. Разберите сцену заново.');
        }

        if (!isTimelineReady(input.chapter.stage)) throw new AiHttpError(409, TIMELINE_PUBLICATION_REQUIRED);

        const createReview = (eventId: string | null) => tx.timelineReview.create({
          data: { jobId, proposalIndex: index, disposition: decision.disposition, quote: proposal.quote, eventId },
        });
        if (decision.disposition === 'dismissed') return createReview(null);

        const where = { projectId: input.worldId };
        const target = decision.eventId
          ? await tx.timelineEvent.findFirst({ where: { ...where, id: decision.eventId }, select: { id: true, name: true, metadata: true } })
          : null;
        if (decision.eventId && !target) throw new AiHttpError(404, 'Событие не найдено в книге.');
        const relativeTo = proposal.relativeToEventId
          ? await tx.timelineEvent.findFirst({ where: { ...where, id: proposal.relativeToEventId }, select: { id: true, at: true } })
          : null;
        const name = target?.name ?? decision.name ?? proposal.name;
        const referenceAt = proposal.relativeToEventId ? relativeTo?.at ?? null : undefined;
        const latestPreview = resolveTimelineDate(
          proposal.dateText, input.settings.start, proposal.anchorText, input.calendar ?? undefined, referenceAt,
        );
        const expectedAt = decision.expectedAt ?? proposal.at;
        if (proposal.relativeToEventId && (!target || decision.updateDate) && expectedAt !== latestPreview.at) {
          req.log.warn({
            projectId, chapterId: job.timelineChapterId, jobId, proposalIndex: index,
            relativeToEventId: proposal.relativeToEventId, expectedAt, actualAt: latestPreview.at,
          }, 'timeline reference changed before confirmation');
          throw new AiHttpError(409, 'Дата опорного события изменилась. Проверьте обновлённую дату и подтвердите снова.');
        }
        const dateText = decision.at ?? proposal.dateText;
        const date = dateText === proposal.dateText ? latestPreview : resolveTimelineDate(
          dateText, input.settings.start, proposal.anchorText, input.calendar ?? undefined, referenceAt,
        );
        if (decision.updateDate && (!target || date.atNumeric === null || relativeTo?.id === target.id)) {
          throw new AiHttpError(400, 'Для изменения даты нужна однозначная опорная дата в текущем предложении.');
        }

        if (!target || decision.updateDate) {
          const comparable = await tx.timelineEvent.findMany({
            where: { ...where, atNumeric: date.atNumeric, ...(target ? { id: { not: target.id } } : {}) },
            select: { id: true, name: true, at: true },
          });
          if (comparable.some((event) => timelineName(event.name) === timelineName(name) && (date.atNumeric !== null || event.at === date.at))) {
            throw new AiHttpError(409, 'Такое событие уже есть. Выберите его в списке событий.');
          }
        }

        const [location, characters, items] = await Promise.all([
          !target && proposal.locationId
            ? tx.location.findFirst({ where: { ...where, id: proposal.locationId }, select: { id: true } })
            : null,
          tx.character.findMany({ where: { ...where, id: { in: proposal.characterIds } }, select: { id: true } }),
          tx.item.findMany({ where: { ...where, id: { in: proposal.itemIds } }, select: { id: true } }),
        ]);
        const timelineAnalysis = { dateText, relativeToEventId: relativeTo?.id ?? null };
        const event = target ?? await tx.timelineEvent.create({
          data: {
            projectId: input.worldId, name, summary: proposal.summary || null,
            at: date.at, atNumeric: date.atNumeric, locationId: location?.id ?? null,
            metadata: { timelineAnalysis },
          },
          select: { id: true },
        });
        if (target && decision.updateDate) {
          const base = target.metadata && typeof target.metadata === 'object' && !Array.isArray(target.metadata)
            ? target.metadata as Prisma.JsonObject
            : {};
          await tx.timelineEvent.update({
            where: { id: target.id },
            data: {
              at: date.at,
              atNumeric: date.atNumeric,
              metadata: { ...base, timelineAnalysis },
            },
          });
        }
        if (characters.length) await tx.eventCharacter.createMany({
          data: characters.map(({ id }) => ({ eventId: event.id, characterId: id })),
          skipDuplicates: true,
        });
        if (items.length) await tx.eventItem.createMany({
          data: items.map(({ id }) => ({ eventId: event.id, itemId: id })),
          skipDuplicates: true,
        });
        return createReview(event.id);
      });
      return { review: result };
    } catch (error) {
      if (error instanceof AiHttpError) return reply.status(error.statusCode).send({ error: error.message });
      throw error;
    }
  });
};
