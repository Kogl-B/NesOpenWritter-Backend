import { z } from 'zod';

export const factKey = z.string().regex(/^[a-zA-Z0-9_-]{1,40}$/);
const subject = z.object({
  kind: z.enum(['character', 'item', 'place', 'row', 'other']),
  id: factKey.optional(),
  tableId: factKey.optional(),
  name: z.string().trim().min(1).max(160),
});
const revisionInput = z.object({
  revisionId: z.string().uuid(),
  action: z.enum(['create', 'story', 'correct']),
  previousId: z.string().uuid().optional(),
  periodId: z.string().uuid().optional(),
  value: z.string().trim().min(1).max(1200),
  certainty: z.enum(['canon', 'draft', 'viewpoint']),
  from: z.string().trim().max(160),
  eventId: factKey.nullable(),
  source: z.object({ unitId: factKey, quote: z.string().trim().min(1).max(800) }).nullable(),
});
const field = z.string().trim().min(1).max(100);

export const factInput = revisionInput.extend({ subject: subject.optional(), field: field.optional() }).superRefine((entry, ctx) => {
  if (entry.action === 'create' ? !entry.subject || !entry.field || entry.previousId || entry.periodId
    : !entry.previousId || (entry.action === 'correct' && !entry.periodId)) {
    ctx.addIssue({ code: 'custom', message: 'Не указана исходная версия факта' });
  }
  if (entry.action === 'story' && !entry.from && !entry.eventId) {
    ctx.addIssue({ code: 'custom', message: 'Укажите момент изменения по сюжету' });
  }
});

const revision = revisionInput.omit({ previousId: true }).extend({
  periodId: z.string().uuid(),
  recordedAt: z.string(),
  authorId: factKey,
});
const fact = z.object({
  id: z.string().uuid(),
  subject,
  field,
  revisions: z.array(revision).min(1),
});

export type WorldFact = z.infer<typeof fact>;
export type WorldFactInput = z.infer<typeof factInput>;
export type FactRevision = z.infer<typeof revision>;

export function objectOf(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function readWorldFacts(raw: unknown): WorldFact[] {
  return Array.isArray(raw) ? raw.flatMap((entry) => {
    const parsed = fact.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  }) : [];
}

/** Сюжетный поворот добавляет период, исправление заменяет значение в выбранном периоде. */
export function factPeriods(entry: WorldFact): FactRevision[] {
  const periods = new Map<string, FactRevision>();
  for (const version of entry.revisions) periods.set(version.periodId, version);
  return [...periods.values()];
}

export function updateFact(current: WorldFact | undefined, id: string, input: WorldFactInput, authorId: string, now: string) {
  if (current?.revisions.some((version) => version.revisionId === input.revisionId)) return { fact: current, changed: false } as const;
  if (!current && input.action !== 'create') return { issue: 'Факт недоступен' } as const;
  if (current && (input.action === 'create' || current.revisions.at(-1)?.revisionId !== input.previousId)) {
    return { issue: 'Факт уже изменился. Откройте его заново.' } as const;
  }
  if (current && current.revisions.length >= 60) return { issue: 'Достигнут лимит версий факта' } as const;
  const period = input.action === 'correct' && current
    ? factPeriods(current).find((entry) => entry.periodId === input.periodId) : undefined;
  if (input.action === 'correct' && !period) return { issue: 'Период недоступен' } as const;
  const { previousId: _previous, subject: target, field: property, ...data } = input;
  const saved = {
    ...data, authorId, recordedAt: now, periodId: period?.periodId ?? input.revisionId,
  };
  const next = current
    ? { ...current, revisions: [...current.revisions, saved] }
    : { id, subject: target!, field: property!, revisions: [saved] };
  return { fact: next, changed: true } as const;
}
