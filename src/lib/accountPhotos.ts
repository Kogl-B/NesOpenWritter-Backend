import { prisma } from './prisma.js';
import { env } from './env.js';
import { syncStoredFiles } from './storedFileSync.js';

export const PHOTO_PAGE = 24;

export type PhotoPlace = 'avatar' | 'cover' | 'portrait' | 'item' | 'table' | 'manuscript' | 'blog' | 'map' | 'file';

const PLACE_LABEL: Record<PhotoPlace, string> = {
  avatar: 'Аватар',
  cover: 'Обложка',
  portrait: 'Портрет',
  item: 'Предмет',
  table: 'Таблица',
  manuscript: 'Рукопись',
  blog: 'Блог',
  map: 'Карта',
  file: 'Хранилище',
};

const PLACE_RANK: Record<PhotoPlace, number> = {
  avatar: 0,
  cover: 1,
  portrait: 2,
  item: 3,
  table: 4,
  manuscript: 5,
  blog: 6,
  map: 7,
  file: 8,
};

export interface AccountPhoto {
  id: string;
  href: string;
  title: string;
  place: PhotoPlace;
  placeLabel: string;
  projectName: string;
  at: string;
}

export function photoHref(value: unknown, publicBase = ''): string {
  if (typeof value !== 'string') return '';
  const href = value.trim();
  if (href.startsWith('data:image/') && href.length > 22 && href.length <= 250_000) return href;
  if (/^https:\/\/\S+$/i.test(href) && href.length <= 2000) return href;
  const base = publicBase.replace(/\/$/, '');
  if (base && href.startsWith('users/') && !href.includes('..') && !href.includes('\\') && href.length <= 500) {
    return `${base}/${href}`;
  }
  return '';
}

/** Достаёт адреса картинок из текста главы или записи. Обычные ссылки на страницы не берёт. */
export function imageUrlsFromText(text: string): string[] {
  const found: string[] = [];
  const re = /data:image\/(?:png|jpeg|jpg|webp|gif);base64,[a-z0-9+/=]+|https:\/\/[^\s"'<>\\)]+/gi;
  for (const match of text.matchAll(re)) {
    let url = match[0] ?? '';
    url = url.replace(/[),.;]+$/g, '');
    if (url.startsWith('data:image/')) {
      if (url.length <= 250_000) found.push(url);
      continue;
    }
    if (url.length <= 2000 && /\.(?:png|jpe?g|webp|gif)(?:$|\?)/i.test(url)) found.push(url);
  }
  return found;
}

function photoId(href: string): string {
  let hash = 0;
  for (let i = 0; i < href.length; i += 1) hash = (Math.imul(hash, 31) + href.charCodeAt(i)) | 0;
  return `p${(hash >>> 0).toString(36)}`;
}

export function makePhoto(input: {
  href: string;
  title: string;
  place: PhotoPlace;
  projectName?: string;
  at?: string;
  publicBase?: string;
}): AccountPhoto | null {
  const href = photoHref(input.href, input.publicBase ?? '');
  if (!href) return null;
  const title = input.title.replace(/\s+/g, ' ').trim().slice(0, 160) || PLACE_LABEL[input.place];
  return {
    id: photoId(href),
    href,
    title,
    place: input.place,
    placeLabel: PLACE_LABEL[input.place],
    projectName: (input.projectName ?? '').replace(/\s+/g, ' ').trim().slice(0, 160),
    at: input.at && !Number.isNaN(Date.parse(input.at)) ? input.at : '1970-01-01T00:00:00.000Z',
  };
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

/** Обложка и фото ячеек таблиц мира. */
export function photosInSettings(settings: unknown, projectName: string, at: string, publicBase = ''): AccountPhoto[] {
  const root = record(settings);
  const out: AccountPhoto[] = [];
  const cover = makePhoto({
    href: typeof root.cover === 'string' ? root.cover : '',
    title: projectName || 'Обложка',
    place: 'cover',
    projectName,
    at,
    publicBase,
  });
  if (cover) out.push(cover);
  const tables = Array.isArray(root.worldTables) ? root.worldTables : [];
  for (const item of tables) {
    const table = record(item);
    const title = typeof table.title === 'string' ? table.title.trim() : '';
    const columns = Array.isArray(table.columns) ? table.columns : [];
    const photoIds = columns.flatMap((col) => {
      const row = record(col);
      return row.kind === 'photo' && typeof row.id === 'string' ? [row.id] : [];
    });
    const textId = columns.flatMap((col) => {
      const row = record(col);
      return row.kind === 'text' && typeof row.id === 'string' ? [row.id] : [];
    })[0] ?? '';
    const rows = Array.isArray(table.rows) ? table.rows : [];
    for (const raw of rows) {
      const row = record(raw);
      const cells = record(row.cells);
      const rowTitle = textId && typeof cells[textId] === 'string' ? cells[textId].trim() : '';
      for (const id of photoIds) {
        const photo = makePhoto({
          href: typeof cells[id] === 'string' ? cells[id] : '',
          title: [title, rowTitle].filter(Boolean).join(' · ') || 'Фото таблицы',
          place: 'table',
          projectName,
          at,
          publicBase,
        });
        if (photo) out.push(photo);
      }
    }
  }
  return out;
}

/** Одинаковый адрес остаётся один раз, с более точным местом. */
export function mergePhotos(groups: AccountPhoto[][]): AccountPhoto[] {
  const byHref = new Map<string, AccountPhoto>();
  for (const photo of groups.flat()) {
    const prev = byHref.get(photo.href);
    if (!prev || PLACE_RANK[photo.place] < PLACE_RANK[prev.place]) byHref.set(photo.href, photo);
  }
  return [...byHref.values()].sort((left, right) => (
    right.at.localeCompare(left.at) || left.title.localeCompare(right.title, 'ru')
  ));
}

export function pagePhotos(photos: AccountPhoto[], page: number, limit: number): {
  total: number;
  page: number;
  pageSize: number;
  photos: AccountPhoto[];
} {
  const pageSize = Math.min(PHOTO_PAGE, Math.max(1, Math.floor(limit) || PHOTO_PAGE));
  const current = Math.max(1, Math.floor(page) || 1);
  const start = (current - 1) * pageSize;
  return {
    total: photos.length,
    page: current,
    pageSize,
    photos: photos.slice(start, start + pageSize),
  };
}

export function isImageFile(name: string): boolean {
  return /\.(?:png|jpe?g|webp|gif)$/i.test(name.split('?')[0] ?? name);
}

function fileTitle(key: string): string {
  const name = key.split('/').pop() ?? '';
  const bare = name.replace(/^\d+-/, '').replace(/[_]+/g, ' ').trim();
  return bare || 'Картинка';
}

function storedPlace(kind: string): PhotoPlace {
  if (kind === 'portrait') return 'portrait';
  if (kind === 'item') return 'item';
  if (kind === 'map') return 'map';
  return 'file';
}

/** Все картинки кабинета: файлы, обложки, портреты, таблицы, рукопись и блог. */
export async function collectAccountPhotos(userId: string): Promise<AccountPhoto[]> {
  await syncStoredFiles(userId).catch(() => {});
  const base = env.R2_PUBLIC_BASE_URL ?? '';
  const [user, levels, projects, characters, items, files, chapters, posts] = await Promise.all([
    prisma.user.findUnique({
      where: { id: userId },
      select: { image: true, settings: true, updatedAt: true },
    }),
    prisma.authorLevel.findMany({
      where: { authorId: userId },
      select: { title: true, avatar: true, updatedAt: true },
    }),
    prisma.project.findMany({
      where: { ownerId: userId },
      select: { id: true, name: true, settings: true, updatedAt: true },
    }),
    prisma.character.findMany({
      where: { project: { ownerId: userId }, portraitPath: { not: null } },
      select: { name: true, portraitPath: true, updatedAt: true, project: { select: { name: true } } },
    }),
    prisma.item.findMany({
      where: { project: { ownerId: userId }, imagePath: { not: null } },
      select: { name: true, imagePath: true, updatedAt: true, project: { select: { name: true } } },
    }),
    prisma.storedFile.findMany({
      where: { userId },
      select: { key: true, kind: true, createdAt: true, project: { select: { name: true } } },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.$queryRaw<Array<{ title: string; projectName: string; updatedAt: Date; content: string }>>`
      SELECT c.title, p.name AS "projectName", c."updatedAt", c.content::text AS content
      FROM chapters c
      JOIN projects p ON p.id = c."projectId"
      WHERE p."ownerId" = ${userId}
        AND (
          c.content::text LIKE '%data:image/%'
          OR c.content::text LIKE '%.png%'
          OR c.content::text LIKE '%.jpg%'
          OR c.content::text LIKE '%.jpeg%'
          OR c.content::text LIKE '%.webp%'
          OR c.content::text LIKE '%.gif%'
        )
    `,
    prisma.$queryRaw<Array<{ title: string; updatedAt: Date; body: string }>>`
      SELECT title, "updatedAt", body
      FROM blog_posts
      WHERE "authorId" = ${userId}
        AND (
          body LIKE '%data:image/%'
          OR body LIKE '%.png%'
          OR body LIKE '%.jpg%'
          OR body LIKE '%.jpeg%'
          OR body LIKE '%.webp%'
          OR body LIKE '%.gif%'
        )
    `,
  ]);
  const at = user?.updatedAt.toISOString() ?? new Date(0).toISOString();
  const settings = record(user?.settings);
  const avatars: AccountPhoto[] = [];
  const projectPhotos: AccountPhoto[] = [];
  const entityPhotos: AccountPhoto[] = [];
  const manuscriptPhotos: AccountPhoto[] = [];
  const blogPhotos: AccountPhoto[] = [];
  const storedPhotos: AccountPhoto[] = [];
  const avatar = makePhoto({
    href: typeof settings.avatar === 'string' ? settings.avatar : (user?.image ?? ''),
    title: 'Аватар',
    place: 'avatar',
    at,
    publicBase: base,
  });
  if (avatar) avatars.push(avatar);
  for (const level of levels) {
    const photo = makePhoto({
      href: level.avatar,
      title: level.title || 'Аватар уровня',
      place: 'avatar',
      at: level.updatedAt.toISOString(),
      publicBase: base,
    });
    if (photo) avatars.push(photo);
  }
  for (const project of projects) {
    projectPhotos.push(...photosInSettings(project.settings, project.name, project.updatedAt.toISOString(), base));
  }
  for (const character of characters) {
    const photo = makePhoto({
      href: character.portraitPath ?? '',
      title: character.name,
      place: 'portrait',
      projectName: character.project.name,
      at: character.updatedAt.toISOString(),
      publicBase: base,
    });
    if (photo) entityPhotos.push(photo);
  }
  for (const item of items) {
    const photo = makePhoto({
      href: item.imagePath ?? '',
      title: item.name,
      place: 'item',
      projectName: item.project.name,
      at: item.updatedAt.toISOString(),
      publicBase: base,
    });
    if (photo) entityPhotos.push(photo);
  }
  for (const chapter of chapters) {
    for (const href of imageUrlsFromText(chapter.content)) {
      const photo = makePhoto({
        href,
        title: chapter.title || 'Рукопись',
        place: 'manuscript',
        projectName: chapter.projectName,
        at: chapter.updatedAt.toISOString(),
        publicBase: base,
      });
      if (photo) manuscriptPhotos.push(photo);
    }
  }
  for (const post of posts) {
    for (const href of imageUrlsFromText(post.body)) {
      const photo = makePhoto({
        href,
        title: post.title || 'Запись блога',
        place: 'blog',
        at: post.updatedAt.toISOString(),
        publicBase: base,
      });
      if (photo) blogPhotos.push(photo);
    }
  }
  for (const file of files) {
    if (!isImageFile(file.key)) continue;
    const photo = makePhoto({
      href: file.key,
      title: fileTitle(file.key),
      place: storedPlace(file.kind),
      projectName: file.project?.name ?? '',
      at: file.createdAt.toISOString(),
      publicBase: base,
    });
    if (photo) storedPhotos.push(photo);
  }
  return mergePhotos([avatars, projectPhotos, entityPhotos, manuscriptPhotos, blogPhotos, storedPhotos]);
}
