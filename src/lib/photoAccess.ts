import { createHash, randomBytes } from 'node:crypto';

import { prisma } from './prisma.js';
import { photoHref } from './accountPhotos.js';

export const PHOTO_VISIBILITY = ['private', 'link', 'people', 'public'] as const;

export type PhotoVisibility = (typeof PHOTO_VISIBILITY)[number];

export interface PhotoViewerView {
  id: string;
  name: string;
  email: string;
}

export interface PhotoAccessView {
  visibility: PhotoVisibility;
  token: string;
  viewers: PhotoViewerView[];
}

export function hrefHash(href: string): string {
  return createHash('sha256').update(href).digest('hex');
}

export function photoToken(): string {
  return randomBytes(12).toString('base64url');
}

export function emptyAccess(): PhotoAccessView {
  return { visibility: 'private', token: '', viewers: [] };
}

/** Кто открывает прямую ссылку. Закрытое фото видит только владелец. */
export function canOpenPhoto(input: {
  visibility: string;
  ownerId: string;
  viewerId: string | null;
  granted: boolean;
}): boolean {
  if (input.visibility === 'public' || input.visibility === 'link') return true;
  if (!input.viewerId) return false;
  if (input.viewerId === input.ownerId) return true;
  return input.visibility === 'people' && input.granted;
}

/** Кадр попадает в «Мне открыли», если человека явно пустили и видимость это позволяет. */
export function listedForViewer(visibility: string): boolean {
  return visibility === 'people' || visibility === 'public';
}

function asVisibility(value: string): PhotoVisibility {
  return PHOTO_VISIBILITY.includes(value as PhotoVisibility) ? value as PhotoVisibility : 'private';
}

export async function accessForPage(userId: string, hrefs: string[]): Promise<Map<string, PhotoAccessView>> {
  const hashes = hrefs.map((href) => hrefHash(href));
  if (hashes.length === 0) return new Map();
  const rows = await prisma.photoShare.findMany({
    where: { userId, hrefHash: { in: hashes } },
    include: { viewers: { include: { viewer: { select: { id: true, name: true, email: true } } } } },
  });
  const byHash = new Map(rows.map((row) => [row.hrefHash, row]));
  const out = new Map<string, PhotoAccessView>();
  for (const href of hrefs) {
    const row = byHash.get(hrefHash(href));
    out.set(href, row ? viewOf(row) : emptyAccess());
  }
  return out;
}

function viewOf(row: {
  visibility: string;
  token: string;
  viewers: Array<{ viewer: { id: string; name: string | null; email: string } }>;
}): PhotoAccessView {
  return {
    visibility: asVisibility(row.visibility),
    token: row.token,
    viewers: row.viewers.map((item) => ({
      id: item.viewer.id,
      name: item.viewer.name ?? '',
      email: item.viewer.email,
    })),
  };
}

export async function resolveAccounts(ownerId: string, accounts: string[]): Promise<PhotoViewerView[]> {
  const found: PhotoViewerView[] = [];
  const seen = new Set<string>();
  for (const raw of accounts) {
    const account = raw.trim();
    if (!account) continue;
    const user = await prisma.user.findFirst({
      where: {
        OR: [
          { id: account },
          { email: { equals: account, mode: 'insensitive' } },
        ],
      },
      select: { id: true, name: true, email: true },
    });
    if (!user) {
      const error = new Error(`Аккаунт не найден: ${account}`);
      throw Object.assign(error, { statusCode: 404 });
    }
    if (user.id === ownerId) {
      const error = new Error('Свой аккаунт добавлять не нужно');
      throw Object.assign(error, { statusCode: 400 });
    }
    if (seen.has(user.id)) continue;
    seen.add(user.id);
    found.push({ id: user.id, name: user.name ?? '', email: user.email });
  }
  return found;
}

export async function savePhotoAccess(input: {
  userId: string;
  href: string;
  title: string;
  visibility: PhotoVisibility;
  accounts: string[];
}): Promise<PhotoAccessView> {
  const href = photoHref(input.href, '');
  if (!href) {
    const error = new Error('Это не адрес фотографии');
    throw Object.assign(error, { statusCode: 400 });
  }
  const viewers = input.visibility === 'private' || input.visibility === 'link'
    ? []
    : await resolveAccounts(input.userId, input.accounts);
  const hash = hrefHash(href);
  const existing = await prisma.photoShare.findUnique({
    where: { userId_hrefHash: { userId: input.userId, hrefHash: hash } },
    select: { token: true },
  });
  const row = await prisma.photoShare.upsert({
    where: { userId_hrefHash: { userId: input.userId, hrefHash: hash } },
    create: {
      userId: input.userId,
      hrefHash: hash,
      href,
      title: input.title,
      visibility: input.visibility,
      token: existing?.token ?? photoToken(),
    },
    update: {
      href,
      title: input.title,
      visibility: input.visibility,
    },
  });
  await prisma.photoViewer.deleteMany({ where: { photoId: row.id } });
  if (viewers.length > 0) {
    await prisma.photoViewer.createMany({
      data: viewers.map((viewer) => ({ photoId: row.id, viewerId: viewer.id })),
    });
  }
  return { visibility: input.visibility, token: row.token, viewers };
}

export async function photosSharedWith(viewerId: string): Promise<Array<{
  id: string;
  href: string;
  title: string;
  place: 'file';
  placeLabel: string;
  projectName: string;
  at: string;
  ownerName: string;
}>> {
  const rows = await prisma.photoViewer.findMany({
    where: { viewerId, photo: { visibility: { in: ['people', 'public'] } } },
    include: { photo: { include: { owner: { select: { name: true, email: true } } } } },
    orderBy: { createdAt: 'desc' },
  });
  return rows.filter((row) => listedForViewer(row.photo.visibility)).map((row) => ({
    id: row.photo.id,
    href: row.photo.href,
    title: row.photo.title || 'Фото',
    place: 'file' as const,
    placeLabel: 'Открыто вам',
    projectName: '',
    at: row.createdAt.toISOString(),
    ownerName: row.photo.owner.name || 'Автор',
  }));
}

export async function photoByToken(token: string, viewerId: string | null): Promise<{
  href: string;
  title: string;
  ownerName: string;
} | null> {
  const row = await prisma.photoShare.findUnique({
    where: { token },
    include: {
      owner: { select: { id: true, name: true, email: true } },
      viewers: { select: { viewerId: true } },
    },
  });
  if (!row) return null;
  const granted = viewerId != null && row.viewers.some((item) => item.viewerId === viewerId);
  if (!canOpenPhoto({ visibility: row.visibility, ownerId: row.owner.id, viewerId, granted })) return null;
  return {
    href: row.href,
    title: row.title || 'Фото',
    ownerName: row.owner.name || 'Автор',
  };
}
