import { z } from 'zod';
import { AiHttpError } from '../ai/aiError.js';

const entityId = z.string().min(1).max(40);
const optionalId = entityId.nullable().optional();
const candidateSchema = z.object({
  name: z.string().trim().min(1).max(160),
  summary: z.string().trim().max(1000).default(''),
  quote: z.string().trim().min(8).max(700),
  dateText: z.string().trim().max(160).default(''),
  anchorText: z.string().trim().max(160).default(''),
  locationId: optionalId,
  characterIds: z.array(entityId).max(20).default([]),
  itemIds: z.array(entityId).max(20).default([]),
  existingEventId: optionalId,
  relativeToEventId: optionalId,
});
const resultSchema = z.object({ events: z.array(candidateSchema).max(20) });

export const proposalSchema = candidateSchema.extend({
  at: z.string(),
  atNumeric: z.number().nullable(),
  knownDate: z.string().nullable(),
});
export const proposalsSchema = z.object({ proposals: z.array(proposalSchema) });

export function flat(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}

export function timelineName(text: string): string {
  return flat(text).toLocaleLowerCase('ru-RU').replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function supportedTimeText(source: string, candidate: string): string {
  const phrase = flat(candidate).toLocaleLowerCase('ru-RU');
  if (!phrase) return '';
  const lowered = source.toLocaleLowerCase('ru-RU');
  let index = lowered.indexOf(phrase);
  while (index !== -1) {
    const before = lowered.slice(0, index);
    const clause = before.slice(Math.max(before.lastIndexOf('.'), before.lastIndexOf('!'),
      before.lastIndexOf('?'), before.lastIndexOf(';'), before.lastIndexOf(',')) + 1);
    if (!/(?:^|\s)(?:хотел[аи]?|собирал(?:ся|ась|ись)|намеревал(?:ся|ась|ись)|планировал[аи]?)(?:\s|$)/u.test(clause)) {
      return source.slice(index, index + phrase.length);
    }
    index = lowered.indexOf(phrase, index + phrase.length);
  }
  return '';
}

export function parseExtraction(raw: string, text: string) {
  const decoded = JSON.parse(raw.trim().replace(/^```(?:json)?\s*|\s*```$/gi, '')) as unknown;
  const rawEvents = z.object({ events: z.array(z.unknown()).max(20) }).parse(decoded).events;
  const source = flat(text);
  const events = rawEvents.flatMap((item) => {
    const validated = candidateSchema.safeParse(item);
    if (!validated.success) return [];
    const event = validated.data;
    const quote = flat(event.quote);
    if (!source.includes(quote)) return [];
    let anchorText = supportedTimeText(source, event.anchorText);
    let dateText = supportedTimeText(source, event.dateText);
    if (!dateText) {
      const clocks = [...quote.matchAll(/(?<!\S)(?:в\s+)?(?:\d{1,2}:\d{2}|полдень|полночь)\s+(?:того же дня|в тот же день)(?=$|[\s,.!?;])/giu)];
      const clock = clocks.length === 1 ? clocks[0] : undefined;
      if (clock) {
        if (!anchorText && !event.relativeToEventId) {
          const before = quote.slice(0, clock.index ?? 0);
          const dates = before.match(/\b(?:\d{4}-\d{2}-\d{2}|\d{1,2}[./]\d{1,2}[./]\d{4})\b/gu);
          if (dates?.length === 1) anchorText = supportedTimeText(source, dates[0]!);
        }
        if (anchorText || event.relativeToEventId) dateText = supportedTimeText(source, clock[0]);
      }
    }
    const relativePhrase = /^(после|до) [^,.!?;]{2,65}(?=,)/iu.exec(event.quote)?.[0] ?? '';
    return [{ ...event, dateText: dateText || relativePhrase, anchorText }];
  });
  if (rawEvents.length && !events.length) throw new AiHttpError(502, 'ИИ не вернул событий с проверяемой цитатой. Повторите разбор.');
  return resultSchema.parse({ events }).events;
}
