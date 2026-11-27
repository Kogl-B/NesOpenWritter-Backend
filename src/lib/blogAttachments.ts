import { Prisma } from '@prisma/client';
import { z } from 'zod';

import { prisma } from './prisma.js';
import { bookBlocked } from './geo/policy.js';
import type { countryBlocks } from './geo/request.js';

export const attachmentSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('book'), projectId: z.string().trim().min(1).max(80) }),
  z.object({ kind: z.literal('cycle'), name: z.string().trim().min(1).max(500) }),
]);

export type BlogAttachment = z.infer<typeof attachmentSchema>;
export type AttachmentLink = BlogAttachment & { title: string; href: string };
type Book = { id: string; ownerId: string; name: string; cycle: string };

export function readAttachment(value: unknown): BlogAttachment | null {
  const result = attachmentSchema.safeParse(value);
  return result.success ? result.data : null;
}

async function publishedBooks(authorIds: string[]): Promise<Book[]> {
  if (!authorIds.length) return [];
  return prisma.$queryRaw<Book[]>`
    SELECT id, "ownerId", name, btrim(coalesce(settings #>> '{catalog,cycle}', '')) AS cycle
    FROM projects
    WHERE "ownerId" IN (${Prisma.join(authorIds)})
      AND settings #> '{catalog,published}' = 'true'::jsonb
    ORDER BY name, id
  `;
}

function findTarget(books: Book[], authorId: string, attachment: BlogAttachment): Book | undefined {
  return books.find((book) =>
    book.ownerId === authorId && (attachment.kind === 'book' ? book.id === attachment.projectId : book.cycle === attachment.name),
  );
}

export async function canAttach(authorId: string, attachment: BlogAttachment) {
  return !!findTarget(await publishedBooks([authorId]), authorId, attachment);
}

export async function attachmentOptions(authorId: string): Promise<AttachmentLink[]> {
  const books = await publishedBooks([authorId]);
  const cycles = [...new Set(books.map((book) => book.cycle).filter(Boolean))];
  return [
    ...cycles.map((name) => ({ kind: 'cycle' as const, name, title: name, href: cycleUrl(authorId, name) })),
    ...books.map((book) => ({ kind: 'book' as const, projectId: book.id, title: book.name, href: `/books/${book.id}` })),
  ];
}

function cycleUrl(authorId: string, name: string) {
  return `/authors/${authorId}/cycles?cycle=${encodeURIComponent(name)}`;
}

export async function publicAttachments(
  posts: Array<{ id: string; authorId: string; attachment: unknown }>,
  geo: Awaited<ReturnType<typeof countryBlocks>>,
  hiddenBooks: ReadonlySet<string>,
) {
  const linked = posts.flatMap((post) => {
    const attachment = readAttachment(post.attachment);
    return attachment ? [{ ...post, attachment }] : [];
  });
  const books = (await publishedBooks([...new Set(linked.map((post) => post.authorId))]))
    .filter((book) => !hiddenBooks.has(book.id) && !bookBlocked(geo.index, geo.country, book.id));
  const links = new Map<string, AttachmentLink>();
  for (const { id, authorId, attachment } of linked) {
    const book = findTarget(books, authorId, attachment);
    if (!book) continue;
    links.set(id, attachment.kind === 'book'
      ? { ...attachment, title: book.name, href: `/books/${book.id}` }
      : { ...attachment, title: attachment.name, href: cycleUrl(authorId, attachment.name) });
  }
  return links;
}
