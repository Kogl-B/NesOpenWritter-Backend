const PHOTO_URL = /^https?:\/\/\S+$/i;
const HTTPS_URL = /^https:\/\/\S+$/i;
const COLUMN_LIMIT = 24;

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return { ...(value as Record<string, unknown>) };
}

/** Адрес обложки: прежний data URL карточки или публичная ссылка полного кадра. */
export function coverHref(value: unknown): string {
  if (typeof value !== 'string') return '';
  if (value.startsWith('data:image/') && value.length <= 220_000) return value;
  if (HTTPS_URL.test(value) && value.length <= 2000) return value;
  return '';
}

/** Кладёт https-адрес в столбец фото строки. Остальные настройки книги не трогает. */
export function placePhotoInSettings(
  settings: unknown,
  tableId: string,
  rowId: string,
  href: string,
): Record<string, unknown> {
  const root = record(settings);
  const safe = href.trim();
  if (!PHOTO_URL.test(safe) || safe.length > 2000) return root;
  const tables = Array.isArray(root.worldTables) ? root.worldTables : [];
  let changed = false;
  const worldTables = tables.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
    const table = item as Record<string, unknown>;
    if (table.id !== tableId) return item;
    const columns = Array.isArray(table.columns) ? [...table.columns] : [];
    const listed = Array.isArray(table.pictureColumnIds)
      ? table.pictureColumnIds.filter((id): id is string => typeof id === 'string')
      : [];
    const photos = columns.filter((col): col is Record<string, unknown> => (
      !!col && typeof col === 'object' && !Array.isArray(col) && (col as { kind?: unknown }).kind === 'photo'
    ));
    let photo = photos.find((col) => typeof col.id === 'string' && listed.includes(col.id)) ?? photos[0];
    let pictureColumnIds = listed;
    if (!photo) {
      if (columns.length >= COLUMN_LIMIT) return item;
      const id = `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      photo = { id, name: 'Фото', kind: 'photo', width: 160, options: [] };
      columns.push(photo);
      pictureColumnIds = [...listed, id];
    }
    const photoId = String(photo.id ?? '');
    if (!photoId) return item;
    if (!pictureColumnIds.includes(photoId)) pictureColumnIds = [...pictureColumnIds, photoId];
    const rows = Array.isArray(table.rows) ? table.rows : [];
    let rowHit = false;
    const nextRows = rows.map((row) => {
      if (!row || typeof row !== 'object' || Array.isArray(row)) return row;
      const current = row as Record<string, unknown>;
      if (current.id !== rowId) return row;
      rowHit = true;
      const cells = current.cells && typeof current.cells === 'object' && !Array.isArray(current.cells)
        ? { ...(current.cells as Record<string, unknown>) }
        : {};
      cells[photoId] = safe;
      return { ...current, cells };
    });
    if (!rowHit) return item;
    changed = true;
    return { ...table, columns, pictureColumnIds, rows: nextRows };
  });
  if (!changed) return root;
  return { ...root, worldTables };
}

function photoColumns(table: Record<string, unknown>): Array<{ id: string }> {
  if (!Array.isArray(table.columns)) return [];
  return table.columns.flatMap((col) => {
    if (!col || typeof col !== 'object' || Array.isArray(col)) return [];
    const row = col as Record<string, unknown>;
    if (row.kind !== 'photo' || typeof row.id !== 'string' || !row.id) return [];
    return [{ id: row.id }];
  });
}

/** Пустая ячейка в присланной таблице не стирает фото, уже лежащее в книге. */
export function mergeWorldTablePhotos(existing: unknown, incoming: unknown): unknown {
  if (!Array.isArray(existing) || !Array.isArray(incoming)) return incoming;
  const previous = new Map<string, Record<string, unknown>>();
  for (const item of existing) {
    if (item && typeof item === 'object' && !Array.isArray(item) && typeof (item as { id?: unknown }).id === 'string') {
      previous.set((item as { id: string }).id, item as Record<string, unknown>);
    }
  }
  return incoming.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
    const table = item as Record<string, unknown>;
    if (typeof table.id !== 'string') return item;
    const prior = previous.get(table.id);
    if (!prior) return item;
    const columns = Array.isArray(table.columns) ? [...table.columns] : [];
    const known = new Set(photoColumns(table).map((col) => col.id));
    for (const col of photoColumns(prior)) {
      if (!known.has(col.id) && columns.length < COLUMN_LIMIT) {
        const source = Array.isArray(prior.columns)
          ? prior.columns.find((entry) => entry && typeof entry === 'object' && (entry as { id?: unknown }).id === col.id)
          : null;
        if (source) columns.push(source);
      }
    }
    const photoIds = photoColumns({ columns }).map((col) => col.id);
    if (!photoIds.length) return item;
    const rows = Array.isArray(table.rows) ? table.rows : [];
    const priorRows = new Map<string, Record<string, unknown>>();
    if (Array.isArray(prior.rows)) {
      for (const row of prior.rows) {
        if (row && typeof row === 'object' && !Array.isArray(row) && typeof (row as { id?: unknown }).id === 'string') {
          priorRows.set((row as { id: string }).id, row as Record<string, unknown>);
        }
      }
    }
    const nextRows = rows.map((row) => {
      if (!row || typeof row !== 'object' || Array.isArray(row)) return row;
      const current = row as Record<string, unknown>;
      if (typeof current.id !== 'string') return row;
      const old = priorRows.get(current.id);
      if (!old || !old.cells || typeof old.cells !== 'object' || Array.isArray(old.cells)) return row;
      const cells = current.cells && typeof current.cells === 'object' && !Array.isArray(current.cells)
        ? { ...(current.cells as Record<string, unknown>) }
        : {};
      let changed = false;
      for (const id of photoIds) {
        const here = typeof cells[id] === 'string' ? cells[id].trim() : '';
        const there = (old.cells as Record<string, unknown>)[id];
        if (!here && typeof there === 'string' && PHOTO_URL.test(there.trim()) && there.trim().length <= 2000) {
          cells[id] = there.trim();
          changed = true;
        }
      }
      if (!changed && current.cells) return row;
      return { ...current, cells };
    });
    return { ...table, columns, rows: nextRows };
  });
}

/** Ставит публичный адрес обложки. Короткий data URL по-прежнему принимает каталог. */
export function placeCoverInSettings(settings: unknown, href: string): Record<string, unknown> {
  const root = record(settings);
  const safe = href.trim();
  if (!HTTPS_URL.test(safe) || safe.length > 2000) return root;
  return { ...root, cover: safe };
}
