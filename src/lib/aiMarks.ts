export interface AiChapterRow {
  id: string;
  parentId: string | null;
  kind: string;
  aiCreated: boolean;
  aiReviewed: boolean;
}

export interface AiBookScore {
  chapters: number;
  manualCreated: number;
  manualReviewed: number;
  createdPercent: number | null;
  reviewedPercent: number | null;
}

function tainted(
  rows: AiChapterRow[],
  children: Map<string, AiChapterRow[]>,
  id: string,
  field: 'aiCreated' | 'aiReviewed',
  seen = new Set<string>(),
): boolean {
  if (seen.has(id)) return false;
  seen.add(id);
  const self = rows.find((row) => row.id === id);
  if (self?.[field]) return true;
  for (const child of children.get(id) ?? []) {
    if (tainted(rows, children, child.id, field, seen)) return true;
  }
  return false;
}

/** Доля глав без отметки. Сцена внутри главы помечает всю главу. */
export function scoreChapters(rows: AiChapterRow[]): AiBookScore {
  const children = new Map<string, AiChapterRow[]>();
  for (const row of rows) {
    if (!row.parentId) continue;
    const list = children.get(row.parentId) ?? [];
    list.push(row);
    children.set(row.parentId, list);
  }
  const chapters = rows.filter((row) => row.kind === 'chapter');
  const units = chapters.length > 0 ? chapters : rows.filter((row) => row.kind === 'scene');
  const empty: AiBookScore = {
    chapters: 0,
    manualCreated: 0,
    manualReviewed: 0,
    createdPercent: null,
    reviewedPercent: null,
  };
  if (units.length === 0) return empty;
  const manualCreated = units.filter((row) => !tainted(rows, children, row.id, 'aiCreated')).length;
  const manualReviewed = units.filter((row) => !tainted(rows, children, row.id, 'aiReviewed')).length;
  return {
    chapters: units.length,
    manualCreated,
    manualReviewed,
    createdPercent: Math.round((manualCreated / units.length) * 100),
    reviewedPercent: Math.round((manualReviewed / units.length) * 100),
  };
}
