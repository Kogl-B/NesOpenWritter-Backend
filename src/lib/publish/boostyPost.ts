export interface BoostyLink {
  url: string;
  title?: string;
}

export interface BoostyImage {
  id: string;
  url: string;
  width: number;
  height: number;
  size: number;
}

export interface BoostyDraft {
  title: string;
  paragraphs: string[];
  links?: BoostyLink[];
  images?: BoostyImage[];
}

export interface BoostyCreatedPost {
  id: string;
  title: string;
  url: string;
  published: boolean;
}

interface TextBlock {
  type: 'text';
  content: string;
  modificator: string;
}

/** Адрес блога https://boosty.to/name превращается в name. */
export function boostyBlogSlug(bookUrl: string): string {
  let url: URL;
  try {
    url = new URL(bookUrl);
  } catch {
    throw new Error('У аккаунта Boosty нет адреса блога');
  }
  const host = url.hostname.toLowerCase();
  if (host !== 'boosty.to' && !host.endsWith('.boosty.to')) {
    throw new Error('У аккаунта Boosty нет адреса блога');
  }
  const slug = url.pathname.split('/').filter(Boolean)[0] ?? '';
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(slug)) {
    throw new Error('У аккаунта Boosty нет адреса блога');
  }
  return slug;
}

function textBlock(text: string): TextBlock {
  return {
    type: 'text',
    content: JSON.stringify([text, 'unstyled', []]),
    modificator: '',
  };
}

function endBlock(): TextBlock {
  return { type: 'text', content: '', modificator: 'BLOCK_END' };
}

const POST_ID = /^[0-9a-f-]{8,80}$/i;

/** Идентификатор поста, который можно подставить в адрес запроса. */
export function boostyPostId(value: string): string {
  const id = value.trim();
  if (!POST_ID.test(id)) throw new Error('Не найден пост Boosty');
  return id;
}

function httpsUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error('Ссылка должна начинаться с https://');
  }
  if (url.protocol !== 'https:' || !url.hostname) throw new Error('Ссылка должна начинаться с https://');
  return url;
}

function imageBlock(image: BoostyImage): Record<string, string | number> {
  const id = image.id.trim();
  if (!POST_ID.test(id)) throw new Error('Фото Boosty не читается');
  const url = httpsUrl(image.url);
  if (url.hostname !== 'images.boosty.to' || !url.pathname.includes(`/image/${id}`)) {
    throw new Error('Фото должно быть загружено на Boosty');
  }
  return {
    type: 'image',
    id,
    url: `https://images.boosty.to/image/${id}`,
    width: Math.max(0, Math.floor(image.width)),
    height: Math.max(0, Math.floor(image.height)),
    size: Math.max(0, Math.floor(image.size)),
    rendition: '',
  };
}

function linkBlock(link: BoostyLink): Record<string, string | boolean> {
  const url = httpsUrl(link.url);
  if (url.toString().length > 500) throw new Error('Ссылка слишком длинная');
  const title = (link.title ?? url.toString()).replace(/\s+/g, ' ').trim().slice(0, 200) || url.toString();
  return {
    type: 'link',
    content: JSON.stringify([title, 'unstyled', []]),
    url: url.toString(),
    explicit: false,
  };
}

/** Абзацы в блоки редактора Boosty: текст и конец абзаца. */
export function boostyTextBlocks(paragraphs: string[]): TextBlock[] {
  const blocks: TextBlock[] = [];
  for (const paragraph of paragraphs) {
    const text = paragraph.replace(/\u00a0/g, ' ').trim();
    if (!text) continue;
    blocks.push(textBlock(text), endBlock());
  }
  return blocks;
}

/** Тело черновика: бесплатный пост, без тизера и тегов. */
export function boostyDraftForm(draft: BoostyDraft): URLSearchParams {
  const title = draft.title.replace(/\s+/g, ' ').trim();
  if (!title) throw new Error('Укажите заголовок поста');
  const blocks = [
    ...boostyTextBlocks(draft.paragraphs),
    ...(draft.images ?? []).flatMap((image) => [imageBlock(image), endBlock()]),
    ...(draft.links ?? []).flatMap((link) => [linkBlock(link), endBlock()]),
  ];
  if (blocks.length === 0) throw new Error('Напишите текст поста');
  return new URLSearchParams({
    title: title.slice(0, 200),
    data: JSON.stringify(blocks),
    price: '0',
    teaser_data: '[]',
    tags: '',
    deny_comments: 'false',
    deny_reactions: 'false',
    wait_video: 'false',
    advertiser_info: '',
    bundle_ids: '',
  });
}

/** Фото из ответа загрузки: сам объект или обёртка data. */
export function boostyImageFrom(body: unknown): BoostyImage {
  const root = recordOf(body);
  const nested = recordOf(root?.data) ?? recordOf(root?.image) ?? recordOf(root?.file);
  const row = typeof nested?.id === 'string' ? nested : root;
  const id = typeof row?.id === 'string' ? row.id.trim() : '';
  if (!POST_ID.test(id)) {
    const keys = root ? Object.keys(root).slice(0, 8).join(', ') : '';
    throw new Error(keys ? `Boosty не принял фото (${keys})` : 'Boosty не принял фото');
  }
  const width = Number(row?.width ?? 0);
  const height = Number(row?.height ?? 0);
  const size = Number(row?.size ?? 0);
  return {
    id,
    url: `https://images.boosty.to/image/${id}`,
    width: Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0,
    height: Number.isFinite(height) ? Math.max(0, Math.floor(height)) : 0,
    size: Number.isFinite(size) ? Math.max(0, Math.floor(size)) : 0,
  };
}

export function boostyAttachments(body: unknown): { images: string[]; links: string[] } {
  const post = postRecord(body);
  const data = Array.isArray(post?.data) ? post.data : [];
  const images: string[] = [];
  const links: string[] = [];
  for (const item of data) {
    const block = recordOf(item);
    if (!block) continue;
    if (block.type === 'image' && typeof block.id === 'string') images.push(block.id);
    if (block.type === 'link' && typeof block.url === 'string') links.push(block.url);
  }
  return { images, links };
}

function recordOf(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function postRecord(body: unknown): Record<string, unknown> | null {
  const root = recordOf(body);
  const data = recordOf(root?.data);
  return recordOf(data?.post)
    ?? recordOf(root?.post)
    ?? (typeof data?.id === 'string' ? data : null)
    ?? (typeof root?.id === 'string' ? root : null);
}

/** Ответ публикации: сам пост или обёртка data.post. */
export function createdPostFrom(body: unknown, blog: string): BoostyCreatedPost {
  const root = recordOf(body);
  const post = postRecord(body);
  const id = typeof post?.id === 'string' ? post.id : '';
  if (!/^[0-9a-z-]{8,80}$/i.test(id)) {
    const keys = root ? Object.keys(root).slice(0, 8).join(', ') : '';
    throw new Error(keys ? `Boosty не вернул пост (${keys})` : 'Boosty не вернул пост');
  }
  return {
    id,
    title: typeof post?.title === 'string' ? post.title : '',
    url: `https://boosty.to/${blog}/posts/${id}`,
    published: post?.isPublished !== false,
  };
}
