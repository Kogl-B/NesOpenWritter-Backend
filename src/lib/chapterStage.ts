const STAGES = new Set(['new', 'writing', 'done', 'checked', 'published', 'scheduled']);

/** Теги главы: без пустых, без повторов, не длиннее сорока символов. */
export function chapterTags(values: string[] | undefined): string[] | undefined {
  if (!values) return undefined;
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const value of values) {
    const tag = value.replace(/\s+/g, ' ').trim().slice(0, 40);
    const key = tag.toLocaleLowerCase();
    if (!tag || seen.has(key)) continue;
    seen.add(key);
    tags.push(tag);
    if (tags.length >= 20) break;
  }
  return tags;
}

/** Дата плана. Пустая строка стирает срок. Нечитаемая дата — ошибка. */
export function chapterPublishAt(value: string | null | undefined): Date | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value.trim() === '') return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error('Дата публикации не читается');
  return date;
}

export function assertScheduledDate(stage: string | undefined, publishAt: Date | null | undefined): void {
  if (stage === 'scheduled' && !publishAt) throw new Error('Укажите дату и время публикации');
  if (stage && !STAGES.has(stage)) throw new Error('Неизвестный статус главы');
}
