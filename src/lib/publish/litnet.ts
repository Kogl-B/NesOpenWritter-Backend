export interface LitnetBook {
  id: number;
  title: string;
  url: string;
}

export interface LitnetUser {
  id: number;
  name: string;
}

const JWT = /^[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}$/;
const ALIAS = /^[a-z0-9-]{1,160}$/;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown, limit: number): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, limit) : '';
}

function whole(value: unknown): number {
  const id = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : 0;
  return Number.isSafeInteger(id) && id > 0 ? id : 0;
}

function cookieDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Значение cookie _internal_access_token: сам JWT, строка cookie или заголовок. */
export function parseLitnetToken(raw: string): string {
  const source = raw.trim();
  if (!source) throw new Error('Вставьте cookie _internal_access_token');
  if (source.length > 20_000) throw new Error('Сессия слишком длинная');
  const compact = source.replace(/^\s*cookie\s*:/i, '').replace(/\s+/g, '');
  const match = compact.match(/(?:^|;)_internal_access_token=([^;]+)/i);
  const value = match?.[1] ?? compact.replace(/^_internal_access_token(?:=|:)?/i, '');
  const decoded = value.includes('%') ? cookieDecode(value) : value;
  const token = decoded.replace(/^"+|"+$/g, '');
  if (!JWT.test(token)) {
    throw new Error('Сессия Литнета не читается. Скопируйте cookie _internal_access_token целиком.');
  }
  return token;
}

export function litnetUser(json: unknown): LitnetUser {
  const row = record(json);
  const data = record(row.data);
  const source = whole(data.id) ? data : row;
  const id = whole(source.id);
  const name = text(source.name, 80);
  if (!id || !name) throw new Error('Литнет не назвал аккаунт');
  return { id, name };
}

export interface LitnetChapterRef {
  id: number;
  title: string;
  draft: boolean;
  url: string;
}

export interface LitnetChapterForm {
  csrf: string;
  bookId: number;
  chapterId: number;
  title: string;
  text: string;
  draft: boolean;
}

function decodeHtml(value: string): string {
  let current = value;
  for (let pass = 0; pass < 2; pass += 1) {
    const next = current
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
      .replace(/&#(\d+);/g, (_, num: string) => String.fromCodePoint(Number(num)));
    if (next === current) break;
    current = next;
  }
  return current;
}

function tag(html: string, id: string): string {
  return (html.match(new RegExp(`<input[^>]*id="${id}"[^>]*>`, 'i')) || [])[0] ?? '';
}

function attr(source: string, name: string): string {
  return (source.match(new RegExp(`${name}="([^"]*)"`)) || [])[1] ?? '';
}

/** Форма добавления или правки части в кабинете. Без формы возвращает null. */
export function litnetChapterForm(html: string): LitnetChapterForm | null {
  if (!html.includes('id="chapter-add-form"')) return null;
  const csrf = attr((html.match(/<input[^>]*name="_csrf"[^>]*>/i) || [])[0] ?? '', 'value');
  const bookId = whole((html.match(/const bookId = '(\d+)'/) || [])[1]);
  const action = attr((html.match(/<form[^>]*id="chapter-add-form"[^>]*>/i) || [])[0] ?? '', 'action');
  const chapterId = whole((action.match(/[?&]id=(\d+)/) || [])[1]);
  const title = decodeHtml(attr(tag(html, 'chapterform-title'), 'value')).trim().slice(0, 250);
  const raw = (html.match(/id="chapterform-text"[^>]*>([\s\S]*?)<\/textarea>/i) || [])[1] ?? '';
  const text = decodeHtml(raw).trim().slice(0, 200_000);
  const checked = [...html.matchAll(/<input[^>]*name="ChapterForm\[publish_type\]"[^>]*>/g)]
    .map((match) => match[0])
    .find((input) => /(?:\schecked(?:=|\s|>)|checked="checked")/.test(input));
  const draft = attr(checked ?? '', 'value') === '1';
  if (!csrf || csrf.length > 500 || !bookId) return null;
  return { csrf, bookId, chapterId, title, text, draft };
}

export function litnetFormError(html: string): string {
  const messages = [
    ...html.matchAll(/class="help-block help-block-error"[^>]*>([^<]+)</g),
    ...html.matchAll(/class="save-error"[^>]*>\s*(?:<span>)?([^<]+)</g),
  ].map((match) => text(decodeHtml(match[1] ?? ''), 180)).filter(Boolean);
  return messages[0] ?? '';
}

/** Оглавление книги в кабинете автора. */
export function litnetChapterList(html: string): LitnetChapterRef[] {
  const chapters: LitnetChapterRef[] = [];
  for (const block of html.split(/<div class="book_parts" id="/).slice(1)) {
    const id = whole(block.slice(0, block.indexOf('"')));
    const title = text(decodeHtml((block.match(/<a href="\/account\/chapter\/edit\?id=\d+">([^<]*)<\/a>/) || [])[1] ?? ''), 250);
    const status = text((block.match(/book_parts_status">\s*([^<]*?)\s*</) || [])[1] ?? '', 40);
    const reader = (block.match(/href="(\/ru\/reader\/[a-z0-9-]+\?c=\d+)"/) || [])[1] ?? '';
    if (!id || !title) continue;
    chapters.push({
      id,
      title,
      draft: /черновик/i.test(status),
      url: reader ? `https://litnet.com${reader}` : `https://litnet.com/account/chapter/edit?id=${id}`,
    });
  }
  return chapters;
}

export function litnetBooksPage(json: unknown): LitnetBook[] {
  const row = record(json);
  const data = record(row.data);
  const list = Array.isArray(row.items) ? row.items : Array.isArray(data.items) ? data.items : [];
  const books: LitnetBook[] = [];
  for (const item of list) {
    const book = record(item);
    const id = whole(book.id);
    const title = text(book.title, 200);
    const alias = text(book.alias, 160).toLowerCase();
    if (!id || !title) continue;
    const url = ALIAS.test(alias) ? `https://litnet.com/ru/book/${alias}` : `https://litnet.com/account/novels/view?id=${id}`;
    books.push({ id, title, url });
  }
  return books;
}
