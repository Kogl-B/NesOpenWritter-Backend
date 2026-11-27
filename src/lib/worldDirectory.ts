import { z } from 'zod';
import { prisma } from './prisma.js';
import { chapterIsHidden } from './publish/visibility.js';

const directoryKey = z.string().trim().min(1).max(40);
export const directoryLocation = z.object({ tableId: directoryKey, rowId: directoryKey });
export const directoryId = z.string().uuid();
const referenceSchema = directoryLocation.extend({
  id: directoryId,
  fields: z.array(directoryKey).max(24),
  label: z.string().max(120).optional(),
  imageColumnId: directoryKey.nullable().optional(),
});
export type DirectoryReference = z.infer<typeof referenceSchema>;

function record(input: unknown): Record<string, unknown> {
  return input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {};
}

function records(input: unknown, limit: number) {
  return Array.isArray(input) ? input.slice(0, limit).map(record) : [];
}

export function mapDirectoryReferences(content: unknown, replace: (reference: DirectoryReference) => unknown): unknown {
  if (!content || typeof content !== 'object' || Array.isArray(content)) return content;
  const node = record(content);
  if (node.type === 'directoryReference') {
    const reference = referenceSchema.safeParse(node.attrs);
    return reference.success ? replace(reference.data) : { type: 'text', text: '' };
  }
  if (Array.isArray(node.content)) return { ...node, content: node.content.map((child) => mapDirectoryReferences(child, replace)) };
  if (typeof node.text === 'string' && /[\uE100\uE101]/.test(node.text)) return { ...node, text: node.text.replace(/[\uE100\uE101]/g, '') };
  return content;
}

export function findDirectoryReference(content: unknown, id: string): DirectoryReference | undefined {
  const node = record(content);
  if (node.type === 'directoryReference') {
    const reference = referenceSchema.safeParse(node.attrs);
    return reference.success && reference.data.id === id ? reference.data : undefined;
  }
  if (!Array.isArray(node.content)) return undefined;
  for (const child of node.content) {
    const match = findDirectoryReference(child, id);
    if (match) return match;
  }
}

function photoUrl(value: string): string {
  if (value.length > 2000 || !/^https?:\/\/[^\s<>]+$/i.test(value)) return '';
  try {
    const url = new URL(value);
    return url.username || url.password ? '' : url.href;
  } catch {
    return '';
  }
}

function directoryRow(settings: unknown, { tableId, rowId }: z.infer<typeof directoryLocation>) {
  const table = records(record(settings).worldTables, 40).find((item) => item.id === tableId);
  const row = table && records(table.rows, 500).find((entry) => entry.id === rowId);
  return table && typeof table.title === 'string' && row ? { table, row, name: table.title } : null;
}

export function publicDirectoryContent(settings: unknown, content: unknown) {
  return mapDirectoryReferences(content, (reference) => {
    const entry = directoryRow(settings, reference);
    const protectedRow = !entry || Object.keys(record(entry.row.readerVisibility)).length > 0;
    return {
      type: 'directoryReference',
      attrs: { ...reference, fields: [], label: protectedRow ? 'Справка' : reference.label },
    };
  });
}

interface ReadingPosition { id: string; orderIndex: number; createdAt: Date }

export function directoryFieldVisible(
  rule: unknown, source: ReadingPosition | undefined, earliest: ReadingPosition | undefined,
): boolean {
  if (rule === undefined || rule === '') return true;
  if (rule === 'private' || !source || !earliest) return false;
  return source.orderIndex > earliest.orderIndex
    || (source.orderIndex === earliest.orderIndex && (
      source.createdAt > earliest.createdAt || (+source.createdAt === +earliest.createdAt && source.id >= earliest.id)
    ));
}

interface DirectoryReader {
  chapterId: string;
  isBlocked: (id: string) => boolean;
}

/** Projects exactly one live row and the columns selected by the author. */
export async function directoryCard(
  projectId: string,
  settings: unknown,
  input: z.infer<typeof directoryLocation> & { fields?: string[] },
  reader?: DirectoryReader,
) {
  const entry = directoryRow(settings, input);
  if (!entry) return null;
  const { table, row, name } = entry;
  const rules = record(row.readerVisibility);
  const requiredChapters = reader ? Object.values(rules).filter(
    (value): value is string => typeof value === 'string' && value !== 'private' && directoryKey.safeParse(value).success,
  ) : [];
  const select = { id: true, orderIndex: true, createdAt: true, parentId: true, kind: true, metadata: true } as const;
  const positions = new Map<string, ReadingPosition>();
  let source: ReadingPosition | undefined;
  if (reader && requiredChapters.length) {
    const current = await prisma.chapter.findFirst({ where: { id: reader.chapterId, projectId }, select });
    const rootId = current?.kind === 'scene' && current.parentId ? current.parentId : current?.id;
    const chapters = await prisma.chapter.findMany({
      where: { projectId, id: { in: [...new Set([...requiredChapters, ...(rootId ? [rootId] : [])])] }, kind: 'chapter' }, select,
    });
    for (const chapter of chapters) {
      if (!chapterIsHidden(chapter.metadata) && !reader.isBlocked(chapter.id)) positions.set(chapter.id, chapter);
    }
    source = rootId ? positions.get(rootId) : undefined;
  }
  const visible = (columnId: string) => !reader || directoryFieldVisible(
    rules[columnId], source, typeof rules[columnId] === 'string' ? positions.get(rules[columnId]) : undefined,
  );
  const cells = record(row.cells);
  const columns = records(table.columns, 24).flatMap(({ id, name, kind }) =>
    typeof id === 'string' && typeof name === 'string' && typeof kind === 'string' ? [{ id, name, kind }] : [],
  );
  const titleColumn = columns.find((column) => column.kind !== 'photo' && column.id === table.titleColumnId)
    ?? columns.find((column) => column.kind === 'text') ?? columns.find((column) => column.kind !== 'photo');
  const selected = typeof input.fields === 'undefined' ? null : new Set(input.fields);
  const shown = columns.filter((column) => visible(column.id) && (!selected || selected.has(column.id)));
  const valueOf = (id: string) => typeof cells[id] === 'string' ? cells[id].trim().slice(0, 8000) : '';
  const needed = titleColumn && visible(titleColumn.id) && !shown.includes(titleColumn) ? [...shown, titleColumn] : shown;
  const idsOf = (kind: string) => needed.filter((column) => column.kind === kind).map((column) => valueOf(column.id)).filter(Boolean);
  const characterIds = idsOf('character');
  const placeIds = idsOf('place');
  const itemIds = idsOf('item');
  const [characters, places, items] = await Promise.all([
    characterIds.length ? prisma.character.findMany({ where: { projectId, id: { in: characterIds } }, select: { id: true, name: true } }) : [],
    placeIds.length ? prisma.location.findMany({ where: { projectId, id: { in: placeIds } }, select: { id: true, name: true } }) : [],
    itemIds.length ? prisma.item.findMany({ where: { projectId, id: { in: itemIds } }, select: { id: true, name: true } }) : [],
  ]);
  const links = new Map([
    ...characters.map((entry) => [`character:${entry.id}`, entry.name] as const),
    ...places.map((entry) => [`place:${entry.id}`, entry.name] as const),
    ...items.map((entry) => [`item:${entry.id}`, entry.name] as const),
  ]);
  const cell = ({ id, kind }: typeof columns[number]) => {
    const value = valueOf(id);
    if (kind === 'photo') return photoUrl(value);
    if (kind === 'checkbox') return value === '1' || value === 'true' ? 'Да' : 'Нет';
    if (kind === 'character' || kind === 'place' || kind === 'item') return links.get(`${kind}:${value}`) ?? '';
    return value;
  };
  return {
    table: name.slice(0, 80),
    title: titleColumn && visible(titleColumn.id) ? cell(titleColumn) || 'Запись справочника' : 'Запись справочника',
    fields: shown.flatMap((column) => {
      const value = cell(column);
      return value ? [{ id: column.id, label: column.name.slice(0, 40), kind: column.kind === 'photo' ? 'photo' as const : 'text' as const, value }] : [];
    }),
  };
}
