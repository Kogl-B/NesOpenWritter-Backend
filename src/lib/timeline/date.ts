import { z } from 'zod';

const MINUTES_PER_DAY = 1440;
const DAY = 86_400_000;
const YEAR_AXIS = 365;
const clockPattern = /(?<!\d)(\d{1,2}):(\d{2})(?!\d)/;
const sameDayTail = /\s+(?:того же дня|в тот же день)$/u;
const referencedEvent = /(?:(?:через|спустя)\s+.+?|на следующий день)\s+после(?:\s|$)/u;
const storyStart = /^(?:(?:в|как|с)\s+)?(?:самом\s+)?начал[оае]\s+(?:(?:этой|нашей)\s+)?(?:истории|повествования)$/u;
const firstStoryDay = /^(?:в\s+)?(?:самый\s+)?первый день\s+(?:(?:этой|нашей)\s+)?(?:истории|повествования)$/u;

export interface StoryCalendar {
  monthsPerYear: number;
  daysPerMonth: number;
  settings: unknown;
}

interface StoryDate {
  day: number;
  minute: number | null;
}

function dayNumber(year: number, month: number, date: number, calendar?: StoryCalendar): number | null {
  if (year < 1 || year > 9999 || month < 1 || month > (calendar?.monthsPerYear ?? 12) ||
      date < 1 || date > (calendar?.daysPerMonth ?? 31)) return null;
  if (calendar) return ((year - 1) * calendar.monthsPerYear + month - 1) * calendar.daysPerMonth + date - 1;
  const utc = new Date(0);
  utc.setUTCFullYear(year, month - 1, date);
  return utc.getUTCMonth() === month - 1 && utc.getUTCDate() === date ? utc.getTime() / DAY : null;
}

function dateParts(day: number, calendar?: StoryCalendar): [number, number, number] {
  if (calendar) {
    const month = Math.floor(day / calendar.daysPerMonth);
    return [Math.floor(month / calendar.monthsPerYear) + 1, month % calendar.monthsPerYear + 1, day % calendar.daysPerMonth + 1];
  }
  const utc = new Date(day * DAY);
  return [utc.getUTCFullYear(), utc.getUTCMonth() + 1, utc.getUTCDate()];
}

function minuteOf(hour: number, minute: number): number | null {
  return hour < 24 && minute < 60 ? hour * 60 + minute : null;
}

function projectAnchor(start: string, calendar?: StoryCalendar): StoryDate | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/.exec(start);
  if (!match) return null;
  const day = dayNumber(Number(match[1]), Number(match[2]), Number(match[3]), calendar);
  const minute = match[4] ? minuteOf(Number(match[4]), Number(match[5])) : null;
  return day === null || (match[4] && minute === null) ? null : { day, minute };
}

export const timelineSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  calendarId: z.string().max(40).default(''),
  start: z.string().max(16).default(''),
}).superRefine(({ start, calendarId }, context) => {
  const example = calendarId ? { monthsPerYear: 24, daysPerMonth: 60, settings: null } : undefined;
  if (start && !projectAnchor(start, example)) {
    context.addIssue({ code: 'custom', path: ['start'], message: 'Некорректная дата или время начала повествования' });
  }
});

export function timelineSettings(projectSettings: unknown): z.infer<typeof timelineSettingsSchema> {
  const raw = (projectSettings as { timelineAnalysis?: unknown } | null)?.timelineAnalysis;
  const settings = timelineSettingsSchema.safeParse(raw ?? {});
  return settings.success ? settings.data : { enabled: false, start: '', calendarId: '' };
}

export function validTimelineStart(start: string, calendar?: StoryCalendar): boolean {
  return !start || projectAnchor(start, calendar) !== null;
}

export function storyMonthNames(calendar?: StoryCalendar): string[] {
  if (!calendar) return months;
  const data = (calendar.settings as { monthNames?: unknown } | null)?.monthNames;
  return Array.isArray(data) ? data.map((name) => typeof name === 'string' ? name.trim().toLocaleLowerCase('ru-RU') : '') : [];
}

const relativeDays = new Map([
  ['позавчера', -2], ['вчера', -1], ['сегодня', 0], ['завтра', 1],
  ['послезавтра', 2], ['на следующий день', 1], ['накануне', -1], ['поутру', 0],
]);

const months = [
  'января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа',
  'сентября', 'октября', 'ноября', 'декабря',
];

function clockAt(text: string): number | null {
  const match = clockPattern.exec(text);
  if (match) return minuteOf(Number(match[1]), Number(match[2]));
  if (/полдень/.test(text)) return 720;
  if (/полночь/.test(text)) return 0;
  return null;
}

function explicitDay(text: string, anchor: StoryDate | null, calendar?: StoryCalendar): number | null | undefined {
  const iso = /\b(\d{4})-(\d{2})-(\d{2})(?!\d)/.exec(text);
  if (iso) return dayNumber(Number(iso[1]), Number(iso[2]), Number(iso[3]), calendar);

  const numeric = /\b(\d{1,2})[./](\d{1,2})(?:[./](\d{4}))?(?![\d./])/.exec(text);
  const named = /(?:^|\s)(\d{1,2})\s+([а-яё]+)(?:\s+(\d{4})(?!\d))?/u.exec(text);
  const monthByName = named?.[2] ? storyMonthNames(calendar).indexOf(named[2]) + 1 : 0;
  if (!numeric && !monthByName) return undefined;
  const yearText = numeric?.[3] ?? named?.[3];
  const year = yearText ? Number(yearText) : anchor ? dateParts(anchor.day, calendar)[0] : null;
  if (year === null) return null;
  return dayNumber(year, numeric ? Number(numeric[2]) : monthByName, Number((numeric ?? named)![1]), calendar);
}

const smallNumbers = new Map([
  ['один', 1], ['одну', 1], ['два', 2], ['две', 2], ['три', 3], ['четыре', 4],
  ['пять', 5], ['шесть', 6], ['семь', 7], ['восемь', 8], ['девять', 9], ['десять', 10],
  ['одиннадцать', 11], ['двенадцать', 12], ['тринадцать', 13], ['четырнадцать', 14],
  ['пятнадцать', 15], ['шестнадцать', 16], ['семнадцать', 17], ['восемнадцать', 18],
  ['девятнадцать', 19], ['двадцать', 20], ['тридцать', 30], ['сорок', 40], ['пятьдесят', 50],
  ['шестьдесят', 60], ['семьдесят', 70], ['восемьдесят', 80], ['девяносто', 90],
]);

const collectiveDays = new Map([
  ['двое', 2], ['трое', 3], ['четверо', 4], ['пятеро', 5], ['шестеро', 6],
  ['семеро', 7], ['восьмеро', 8], ['девятеро', 9], ['десятеро', 10],
]);

function parseAmount(raw: string): number {
  if (!raw) return 1;
  if (/^\d+$/.test(raw)) return Number(raw);
  const parts = raw.trim().split(/\s+/u).map((word) => smallNumbers.get(word));
  if (parts.length === 1 && parts[0] !== undefined) return parts[0];
  if (parts.length === 2 && (parts[0] ?? 0) >= 20 && (parts[1] ?? 0) > 0 && parts[1]! < 10) {
    return parts[0]! + parts[1]!;
  }
  return NaN;
}

function resolve(text: string, anchor: StoryDate | null, calendar?: StoryCalendar): StoryDate | null {
  const source = text.toLowerCase().trim();
  if (!source) return null;
  const clock = clockAt(source);
  if (clockPattern.test(source) && clock === null) return null;
  const explicit = explicitDay(source, anchor, calendar);
  if (explicit !== undefined) return explicit === null ? null : { day: explicit, minute: clock };
  if (!anchor) return null;
  if (storyStart.test(source)) return { day: anchor.day, minute: clock ?? anchor.minute };
  if (firstStoryDay.test(source)) return { day: anchor.day, minute: clock };

  const elapsed = /(?:^|\s)((?:через|спустя)\s+)?(?:(\d+|[а-яё]+(?:\s+[а-яё]+)?)\s+)?(день|дня|дней|сутки|суток|неделю|недели|недель|часа?|часов|минуту|минуты|минут)(?:\s+(назад|спустя))?(?=$|[\s,.!?])/u.exec(source);
  if (elapsed && (elapsed[1] || elapsed[4])) {
    const unit = elapsed[3] ?? '';
    const count = elapsed[2] ?? '';
    const collective = unit.startsWith('сут') ? collectiveDays.get(count) : undefined;
    const amount = (collective ?? parseAmount(count)) * (elapsed[4] === 'назад' ? -1 : 1);
    if (!Number.isSafeInteger(amount)) return null;
    if (/^(час|минут)/.test(unit)) {
      if (anchor.minute === null) return null;
      const offset = anchor.minute + amount * (unit.startsWith('час') ? 60 : 1);
      const days = Math.floor(offset / MINUTES_PER_DAY);
      return { day: anchor.day + days, minute: offset - days * MINUTES_PER_DAY };
    }
    return { day: anchor.day + amount * (unit.startsWith('недел') ? 7 : 1), minute: clock };
  }
  for (const [word, days] of relativeDays) {
    const padded = ` ${source.replace(/[^а-яё0-9:]+/gu, ' ')} `;
    if (padded.includes(` ${word} `)) return { day: anchor.day + days, minute: clock };
  }
  if (/^(?:в\s+)?(?:\d{1,2}:\d{2}|полдень|полночь)$/u.test(source.replace(sameDayTail, '')) && clock !== null) {
    return { day: anchor.day, minute: clock };
  }
  return null;
}

export interface TimelineDate {
  at: string;
  atNumeric: number | null;
  date: string | null;
}

export function resolveTimelineDate(
  text: string, start: string, sceneAnchor = '', calendar?: StoryCalendar, referenceAt?: string | null,
): TimelineDate {
  const unknown = { at: text.trim() || 'без даты', atNumeric: null, date: null };
  const expression = text.toLowerCase().trim();
  const base = projectAnchor(start, calendar);
  const hasExplicitReference = (Boolean(sceneAnchor) || referenceAt !== undefined)
    || sameDayTail.test(expression) || referencedEvent.test(expression);
  const reference = referenceAt ? resolve(referenceAt, base, calendar) : null;
  const anchor = hasExplicitReference
    ? resolve(sceneAnchor, referenceAt === undefined ? base : reference, calendar) ?? reference
    : base;
  const value = resolve(text, anchor, calendar);
  if (!value || !Number.isSafeInteger(value.day)) return unknown;
  const [year, month, date] = dateParts(value.day, calendar);
  if (!(year >= 1 && year <= 9999)) return unknown;

  const pad = (part: number) => String(part).padStart(2, '0');
  const time = value.minute === null ? '' : ` ${pad(Math.floor(value.minute / 60))}:${pad(value.minute % 60)}`;
  const dateLabel = `${pad(date)}.${pad(month)}.${String(year).padStart(4, '0')}${time}`;
  const first = dayNumber(year, 1, 1, calendar)!;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  // Границы годов совпадают с существующей осью. Порядок внутри каждого года
  // сохраняется и в високосный год, а дробная часть учитывает время.
  const daysInYear = calendar ? calendar.monthsPerYear * calendar.daysPerMonth : leap ? 366 : 365;
  const atNumeric = year * YEAR_AXIS + (value.day - first + (value.minute ?? 0) / MINUTES_PER_DAY)
    * YEAR_AXIS / daysInYear;
  return { at: dateLabel, atNumeric, date: dateLabel };
}
