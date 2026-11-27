import { mergeWorldTablePhotos } from './ai/place.js';

interface TableRecord extends Record<string, unknown> {
  id: string;
}

function hasId(value: unknown): value is TableRecord {
  return value !== null && typeof value === 'object' && typeof (value as { id?: unknown }).id === 'string';
}

export function preserveWorldReaderRules(current: unknown, incoming: unknown): unknown {
  if (!Array.isArray(current) || !Array.isArray(incoming)) return incoming;
  const previous = new Map(current.filter(hasId).map((table) => [table.id, table]));
  return incoming.map((table) => {
    if (!hasId(table) || !Array.isArray(table.rows)) return table;
    const oldRows = previous.get(table.id)?.rows;
    if (!Array.isArray(oldRows)) return table;
    const oldById = new Map(oldRows.filter(hasId).map((row) => [row.id, row]));
    return { ...table, rows: table.rows.map((row: unknown) => {
      if (!hasId(row)) return row;
      const saved = oldById.get(row.id);
      if (!saved) return row;
      const { readerVisibility: _incoming, ...rest } = row;
      return saved.readerVisibility === undefined ? rest : { ...rest, readerVisibility: saved.readerVisibility };
    }) };
  });
}

export interface WorldReaderRule {
  tableId: string;
  rowId: string;
  columnId: string;
  rule: string;
}

export function applyWorldReaderRules(tables: unknown[], rules: WorldReaderRule[]): unknown[] | null {
  if (!rules.length) return tables;
  const tableIndex = new Map(tables.filter(hasId).map((table) => [table.id, table]));
  const updated = new Map<string, TableRecord>();
  for (const { tableId, rowId, columnId, rule } of rules) {
    const table = updated.get(tableId) ?? tableIndex.get(tableId);
    if (!table || !Array.isArray(table.columns) || !Array.isArray(table.rows)
      || !table.columns.some((column: unknown) => hasId(column) && column.id === columnId)) return null;
    const row = table.rows.find((entry: unknown) => hasId(entry) && entry.id === rowId);
    if (!hasId(row)) return null;
    const previous = row.readerVisibility;
    const visibility = previous && typeof previous === 'object' && !Array.isArray(previous) ? { ...previous } as Record<string, unknown> : {};
    if (rule) visibility[columnId] = rule;
    else delete visibility[columnId];
    const { readerVisibility: _old, ...rest } = row;
    const next = Object.keys(visibility).length ? { ...rest, readerVisibility: visibility } : rest;
    updated.set(tableId, { ...table, rows: table.rows.map((entry: unknown) => entry === row ? next : entry) });
  }
  return tables.map((table) => hasId(table) ? updated.get(table.id) ?? table : table);
}

/** Применяется под блокировкой проекта. Сохраняет порядок и серверные фото строк. */
export function applyWorldTableChanges(current: unknown, changes: { upsert: TableRecord[]; remove: string[] }) {
  const original: unknown[] = Array.isArray(current) ? current : [];
  const merged = mergeWorldTablePhotos(original, changes.upsert);
  const upsert = (preserveWorldReaderRules(original, merged) as unknown[]).filter(hasId);
  const replacements = new Map(upsert.map((table) => [table.id, table]));
  const unused = new Set(replacements.keys());
  const removed = new Set(changes.remove);
  const tables: unknown[] = [];
  for (const table of original) {
    if (!hasId(table)) {
      tables.push(table);
      continue;
    }
    if (removed.has(table.id)) continue;
    tables.push(replacements.get(table.id) ?? table);
    unused.delete(table.id);
  }
  for (const table of upsert) {
    if (unused.has(table.id)) tables.push(table);
  }
  return { tables, upsert };
}

export interface WorldCellChange {
  tableId: string;
  rowId: string;
  columnId: string;
  kind: string;
  value: string;
}

/** Меняет указанные ячейки внутри той же блокировки, что и изменение состава таблиц. */
export function applyWorldCellChanges(tables: unknown[], changes: WorldCellChange[]): unknown[] | null {
  if (!changes.length) return tables;
  const changesByTable = new Map<string, WorldCellChange[]>();
  for (const change of changes) {
    let forTable = changesByTable.get(change.tableId);
    if (!forTable) changesByTable.set(change.tableId, forTable = []);
    forTable.push(change);
  }

  let applied = 0;
  const result = tables.map((value) => {
    if (!hasId(value)) return value;
    const pending = changesByTable.get(value.id);
    if (!pending || !Array.isArray(value.columns) || !Array.isArray(value.rows)) return value;
    const kinds = new Map(value.columns.filter(hasId).map((column) => [column.id, column.kind]));
    const rows = new Map<string, WorldCellChange[]>();
    for (const change of pending) {
      if (change.kind === 'photo' || kinds.get(change.columnId) !== change.kind) continue;
      let forRow = rows.get(change.rowId);
      if (!forRow) rows.set(change.rowId, forRow = []);
      forRow.push(change);
    }

    return {
      ...value,
      rows: value.rows.map((row: unknown) => {
        if (!hasId(row)) return row;
        const edits = rows.get(row.id);
        if (!edits) return row;
        const source = row.cells && typeof row.cells === 'object' && !Array.isArray(row.cells) ? row.cells : {};
        const cells = { ...source, ...Object.fromEntries(edits.map((change) => [change.columnId, change.value])) };
        applied += edits.length;
        rows.delete(row.id);
        return { ...row, cells };
      }),
    };
  });
  return applied === changes.length ? result : null;
}
