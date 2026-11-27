import { createHash } from 'node:crypto';
import { z } from 'zod';

import { getProjectAccess } from '../access.js';
import { AiHttpError } from '../ai/aiError.js';
import { performComplete } from '../ai/completeWork.js';
import { prisma } from '../prisma.js';
import { resolveTimelineDate, storyMonthNames, timelineSettings } from './date.js';
import { isTimelineReady, TIMELINE_PUBLICATION_REQUIRED } from './publication.js';
import { flat, parseExtraction, proposalSchema, timelineName } from './proposals.js';

const ANALYSIS_VERSION = 4;
const MAX_CHUNK = 6000;
const MAX_CHAPTER = 60000;
const requestSchema = z.object({ version: z.string().length(64), automatic: z.boolean() });

type ManuscriptDb = Pick<typeof prisma, 'chapter' | 'calendar'>;
type ManuscriptNode = {
  type?: string;
  text?: string;
  attrs?: { id?: string; label?: string; src?: string };
  content?: ManuscriptNode[];
};

function manuscriptText(content: unknown) {
  const mentions = new Set<string>();
  function render(node: ManuscriptNode | null): string {
    if (!node || typeof node !== 'object') return '';
    if (node.type === 'mention') {
      if (node.attrs?.id) mentions.add(node.attrs.id);
      return node.attrs?.label ?? '';
    }
    if (node.type === 'text') return node.text ?? '';
    if (node.type === 'hardBreak') return '\n';
    const values = Array.isArray(node.content) ? node.content.map(render) : [];
    return values.join(['doc', 'blockquote', 'bulletList', 'orderedList', 'table', 'tableRow'].includes(node.type ?? '') ? '\n' : '');
  }
  return { text: render(content as ManuscriptNode | null).trim(), mentions };
}

export async function timelineInput(db: ManuscriptDb, projectId: string, chapterId: string) {
  const chapter = await db.chapter.findFirst({
    where: { id: chapterId, projectId },
    select: { title: true, content: true, stage: true, project: { select: { settings: true } } },
  });
  if (!chapter) return null;
  const { text, mentions } = manuscriptText(chapter.content);
  const settings = timelineSettings(chapter.project.settings);
  const calendar = settings.calendarId
    ? await db.calendar.findFirst({
        where: { id: settings.calendarId, projectId },
        select: { monthsPerYear: true, daysPerMonth: true, settings: true },
      })
    : null;
  const version = createHash('sha256').update(JSON.stringify([
    ANALYSIS_VERSION, text, [...mentions].sort(), settings.start, settings.calendarId,
    calendar && [calendar.monthsPerYear, calendar.daysPerMonth, storyMonthNames(calendar)],
  ])).digest('hex');
  return { chapter, text, mentions, settings, calendar, version };
}

export function checkTimelineSize(text: string) {
  if (!text) throw new AiHttpError(400, 'В сцене нет текста для разбора.');
  if (text.length > MAX_CHAPTER) {
    throw new AiHttpError(400, 'Для разбора разделите текст длиннее 60 000 знаков на несколько сцен.');
  }
}

function chunks(text: string): string[] {
  const result: string[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const end = Math.min(cursor + MAX_CHUNK, text.length);
    const newline = end < text.length ? text.lastIndexOf('\n', end) : -1;
    const cut = newline > cursor + MAX_CHUNK / 2 ? newline : end;
    result.push(text.slice(cursor, cut));
    cursor = cut;
  }
  return result;
}

interface NamedEntity { id: string; name: string }

function shortName(entry: NamedEntity): NamedEntity {
  return { id: entry.id, name: entry.name.slice(0, 100) };
}

function relevant<T extends NamedEntity>(all: T[], text: string, mentions: Set<string>): T[] {
  const content = timelineName(text);
  return all.map((entry) => ({
    entry,
    rank: (mentions.has(entry.id) ? 2 : 0) + (content.includes(timelineName(entry.name)) ? 1 : 0),
  })).sort((a, b) => b.rank - a.rank).map(({ entry }) => entry).slice(0, 15);
}

function validIds(ids: string[], catalog: NamedEntity[]) {
  const available = new Set(catalog.map(({ id }) => id));
  return [...new Set(ids)].filter((id) => available.has(id));
}

export async function extractTimeline(job: {
  userId: string; projectId: string; timelineChapterId: string | null; request: unknown;
}, email: string): Promise<Record<string, unknown>> {
  const { version, automatic } = requestSchema.parse(job.request);
  const role = await getProjectAccess(job.projectId, job.userId);
  if (!role || role === 'viewer') throw new AiHttpError(403, 'Нет доступа к разбору книги.');
  const input = job.timelineChapterId && await timelineInput(prisma, job.projectId, job.timelineChapterId);
  if (!input || input.version !== version || (automatic && !input.settings.enabled)) {
    throw new AiHttpError(409, 'Текст или настройки изменились до начала разбора.');
  }
  if (!isTimelineReady(input.chapter.stage)) throw new AiHttpError(409, TIMELINE_PUBLICATION_REQUIRED);
  checkTimelineSize(input.text);
  if (input.settings.calendarId && !input.calendar) throw new AiHttpError(409, 'Выбранный календарь удалён. Выберите календарь в настройках книги.');

  const where = { projectId: job.projectId };
  const select = { id: true, name: true };
  const [characters, items, locations, existing] = await Promise.all([
    prisma.character.findMany({ where, select }),
    prisma.item.findMany({ where, select }),
    prisma.location.findMany({ where, select }),
    prisma.timelineEvent.findMany({ where, select: { ...select, at: true, summary: true }, orderBy: { updatedAt: 'desc' } }),
  ]);
  const mentions = new Set([...input.mentions].map((mention) => mention.split(':').at(-1)!));
  const found = new Map<string, z.infer<typeof proposalSchema>>();
  for (const chunk of chunks(input.text)) {
    const chapter = await prisma.chapter.findFirst({
      where: { id: job.timelineChapterId!, projectId: job.projectId },
      select: { stage: true },
    });
    if (!isTimelineReady(chapter?.stage)) throw new AiHttpError(409, TIMELINE_PUBLICATION_REQUIRED);
    const catalog = {
      characters: relevant(characters, chunk, mentions).map(shortName),
      items: relevant(items, chunk, mentions).map(shortName),
      locations: relevant(locations, chunk, mentions).map(shortName),
      events: relevant(existing, chunk, mentions).map((event) => ({
        ...shortName(event), at: event.at.slice(0, 160), summary: event.summary?.slice(0, 100),
      })),
    };
    const answer = await performComplete(job.userId, email, {
      purpose: 'timeline-extract',
      projectId: job.projectId,
      context: JSON.stringify({
        text: chunk, catalog, months: input.calendar ? storyMonthNames(input.calendar) : undefined,
      }),
    });
    for (const candidate of parseExtraction(String(answer.text ?? ''), chunk)) {
      const reference = catalog.events.find((event) => event.id === candidate.relativeToEventId);
      const date = resolveTimelineDate(
        candidate.dateText, input.settings.start, candidate.anchorText, input.calendar ?? undefined, reference?.at,
      );
      const proposal = {
        ...candidate,
        at: date.at,
        atNumeric: date.atNumeric,
        knownDate: date.date,
        locationId: validIds(candidate.locationId ? [candidate.locationId] : [], catalog.locations)[0] ?? null,
        characterIds: validIds(candidate.characterIds, catalog.characters),
        itemIds: validIds(candidate.itemIds, catalog.items),
        existingEventId: validIds(candidate.existingEventId ? [candidate.existingEventId] : [], catalog.events)[0] ?? null,
        relativeToEventId: reference?.id ?? null,
      };
      const key = JSON.stringify([timelineName(proposal.name), flat(proposal.quote)]);
      found.set(key, proposal);
    }
  }
  const latest = await timelineInput(prisma, job.projectId, job.timelineChapterId!);
  if (latest?.version !== version || (automatic && !latest.settings.enabled)) {
    throw new AiHttpError(409, 'Текст или настройки изменились во время разбора.');
  }
  if (!isTimelineReady(latest.chapter.stage)) throw new AiHttpError(409, TIMELINE_PUBLICATION_REQUIRED);
  return { proposals: [...found.values()] };
}
