import { z } from 'zod';

export const catalogCyclePatch = z.object({
  cycleOrder: z.number().int().min(1).max(9999).nullable().optional(),
  cycleBranch: z.string().trim().max(80).optional(),
  cycleEntry: z.boolean().optional(),
}).passthrough();

export function cycleSettings(catalog: Record<string, unknown>) {
  const enabled = typeof catalog.cycle === 'string' && Boolean(catalog.cycle.trim());
  const order = catalog.cycleOrder;
  return {
    cycleOrder: enabled && typeof order === 'number' && Number.isInteger(order) && order >= 1 && order <= 9999 ? order : null,
    cycleBranch: enabled && typeof catalog.cycleBranch === 'string' ? catalog.cycleBranch.trim().slice(0, 80) : '',
    cycleEntry: enabled && catalog.cycleEntry === true,
  };
}

type CycleBook = ReturnType<typeof cycleSettings> & {
  id: string;
  cycle: string;
  createdAt: string;
  authorId: string;
};

export function inCycleOrder<T extends CycleBook>(books: T[]): T[] {
  return [...books].sort((a, b) => (
    a.cycleBranch.localeCompare(b.cycleBranch, 'ru')
    || (a.cycleOrder ?? 10000) - (b.cycleOrder ?? 10000)
    || a.createdAt.localeCompare(b.createdAt)
    || a.id.localeCompare(b.id)
  ));
}

export function bookCycle<T extends CycleBook>(book: T, visible: T[]) {
  const name = book.cycle.trim();
  if (!name) return null;
  const books = inCycleOrder(visible.filter(item => item.authorId === book.authorId && item.cycle.trim() === name));
  const branch = books.filter(item => item.cycleBranch === book.cycleBranch);
  const index = branch.findIndex(item => item.id === book.id);
  return {
    name,
    books,
    entryId: (books.find(item => item.cycleEntry) ?? books[0])?.id ?? null,
    nextId: index >= 0 ? branch[index + 1]?.id ?? null : null,
  };
}
