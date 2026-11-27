import { prisma } from './prisma.js';

export interface ViewerBlocks {
  people: Set<string>;
  books: Set<string>;
  blogs: Set<string>;
}

const EMPTY: ViewerBlocks = { people: new Set(), books: new Set(), blogs: new Set() };

export function idList(value: unknown, skip = ''): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || !item || item === skip || out.includes(item)) continue;
    out.push(item);
    if (out.length >= 500) break;
  }
  return out;
}

/** Списки, которые прячут чужие книги, блоги и людей только у этого читателя. */
export async function viewerBlocks(userId: string | null): Promise<ViewerBlocks> {
  if (!userId) return EMPTY;
  const me = await prisma.user.findUnique({ where: { id: userId }, select: { settings: true } });
  const settings = me?.settings && typeof me.settings === 'object' && !Array.isArray(me.settings)
    ? me.settings as Record<string, unknown>
    : {};
  return {
    people: new Set(idList(settings.blockedAuthorIds, userId)),
    books: new Set(idList(settings.blockedBookIds)),
    blogs: new Set(idList(settings.blockedBlogIds)),
  };
}
