import { z } from 'zod';

const noteFields = z.object({
  id: z.string().uuid(),
  title: z.string().trim().min(1).max(160),
  kind: z.enum(['place', 'character', 'item', 'other']),
  unitId: z.string().min(1).max(40),
  quote: z.string().min(1).max(1200),
  from: z.number().int().min(1),
  to: z.number().int().min(2),
});

export const worldNoteInput = noteFields.refine(({ from, to }) => to > from, { message: 'Некорректное выделение' });

const worldNote = noteFields.extend({
  createdAt: z.string(),
  done: z.boolean(),
});

export function readWorldInbox(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const result = worldNote.safeParse(entry);
    return result.success ? [result.data] : [];
  });
}

export function withoutPrivateWorldData(settings: unknown) {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return settings;
  const { worldInbox: _privateNotes, worldFacts: _privateFacts, ...visible } = settings as Record<string, unknown>;
  return visible;
}
