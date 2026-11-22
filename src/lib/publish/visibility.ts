/** Глава скрыта с сайта только явным `metadata.public === false`. */
export function chapterIsHidden(metadata: unknown): boolean {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return false;
  return (metadata as { public?: unknown }).public === false;
}

/** Книга стоит в каталоге сайта. */
export function bookIsPublished(settings: unknown): boolean {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return false;
  const catalog = (settings as { catalog?: { published?: unknown } }).catalog;
  return catalog?.published === true;
}

/** Снимает скрытие, остальные поля metadata оставляет. */
export function revealMetadata(metadata: unknown): Record<string, unknown> {
  const base = metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    ? { ...(metadata as Record<string, unknown>) }
    : {};
  return { ...base, public: true };
}
