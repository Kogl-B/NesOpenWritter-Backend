export interface AuthorTodayWork {
  id: number;
  title: string;
  url: string;
}

export interface AuthorTodayUser {
  id: number;
  name: string;
  userName: string;
}

export interface AuthorTodayToken {
  token: string;
  userId: number;
  expires: string;
}

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

export function authorTodayMessage(json: unknown): string {
  const row = record(json);
  const direct = text(row.message, 180);
  if (direct) return direct;
  const messages = Array.isArray(row.messages) ? row.messages : [];
  const first = messages.map((item) => text(item, 180)).find(Boolean);
  return first ?? '';
}

/** Скрытое поле именно формы входа, не формы выхода. */
export function authorTodayLoginToken(html: string): string {
  const form = html.split(/id=["']loginForm["']/i)[1]?.split(/<\/form>/i)[0] ?? '';
  const named = form.match(/name=["']__RequestVerificationToken["'][^>]*value=["']([^"']+)["']/i)
    ?? form.match(/value=["']([^"']+)["'][^>]*name=["']__RequestVerificationToken["']/i);
  const token = named?.[1]?.trim() ?? '';
  if (token.length < 10) throw new Error('Author.Today не открыл форму входа');
  return token;
}

/** Ответ формы входа. Код двух факторов и код с почты приходят как успешный ответ с флагом. */
export function authorTodayLoginGate(json: unknown): 'ok' | 'two_factor' | 'email_code' {
  const row = record(json);
  if (row.isSuccessful !== true) {
    throw new Error(authorTodayMessage(row) || 'Author.Today не пустил');
  }
  const data = record(row.data);
  if (data.twoFactorEnabled === true) return 'two_factor';
  if (data.confirmEmailEnabled === true) return 'email_code';
  return 'ok';
}

export function authorTodayToken(json: unknown): AuthorTodayToken {
  const row = record(json);
  const token = text(row.token, 4000);
  const userId = whole(row.userId);
  const expires = text(row.expires, 40);
  if (!token || !userId) throw new Error('Author.Today не выдал токен. Скопируйте cookie LoginCookie заново.');
  return { token, userId, expires };
}

export function authorTodayUser(json: unknown): AuthorTodayUser {
  const row = record(record(json).data && !record(json).id ? record(json).data : json);
  const id = whole(row.id);
  const userName = text(row.userName, 80);
  const name = text(row.fio, 80) || userName;
  if (!id || !name) throw new Error('Author.Today не назвал аккаунт');
  return { id, name, userName };
}

export function authorTodayWorksPage(json: unknown): { works: AuthorTodayWork[]; total: number } {
  const row = record(record(json).items ? json : record(json).data);
  const list = Array.isArray(row.items) ? row.items : [];
  const works: AuthorTodayWork[] = [];
  for (const item of list) {
    const work = record(item);
    const id = whole(work.id);
    const title = text(work.title, 200);
    if (!id || !title) continue;
    works.push({ id, title, url: `https://author.today/work/${id}` });
  }
  const total = whole(row.totalCount) || works.length;
  return { works, total };
}

export function authorTodayChapterBody(input: {
  workId: number;
  chapterId?: number;
  title: string;
  html: string;
  draft: boolean;
}): {
  workId: number;
  chapterId?: number;
  title: string;
  text: string;
  autoPublishTime: string;
  isDraft: boolean;
} {
  const title = input.title.trim();
  if (title.length < 1 || title.length > 200) {
    throw new Error('Заголовок главы на Author.Today — от 1 до 200 символов');
  }
  const html = input.html.trim();
  if (!html) throw new Error('В главе нет текста');
  if (html.length > 200_000) throw new Error('Глава длиннее 200 000 знаков, Author.Today её не примет');
  return {
    workId: input.workId,
    ...(input.chapterId ? { chapterId: input.chapterId } : {}),
    title,
    text: html,
    autoPublishTime: '',
    isDraft: input.draft,
  };
}

export function authorTodayChapterView(json: unknown): {
  id: number;
  workId: number;
  title: string;
  text: string;
  draft: boolean;
} | null {
  const row = record(json);
  const data = record(row.data);
  const source = whole(data.chapterId) || whole(data.id) || whole(data.workId) ? data : row;
  const id = whole(source.chapterId) || whole(source.id);
  if (!id) return null;
  return {
    id,
    workId: whole(source.workId),
    title: text(source.title, 200),
    text: typeof source.text === 'string' ? source.text.slice(0, 200_000) : '',
    draft: source.chapterIsDraft === true || source.isDraft === true,
  };
}

export function authorTodayChapterId(json: unknown): number {
  if (typeof json === 'number') return whole(json);
  const row = record(json);
  return whole(row.chapterId) || whole(row.id) || whole(record(row.data).chapterId) || whole(record(row.data).id);
}

const COOKIE = /^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]+$/;

function cookieDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Значение cookie LoginCookie из строки cookie, заголовка или самого значения. */
export function parseAuthorTodayCookie(raw: string): string {
  const text = raw.trim();
  if (!text) throw new Error('Вставьте cookie LoginCookie');
  if (text.length > 20_000) throw new Error('Сессия слишком длинная');
  const compact = text.replace(/^\s*cookie\s*:/i, '').replace(/\s+/g, '');
  const match = compact.match(/(?:^|;)LoginCookie=([^;]+)/i);
  const value = match?.[1] ?? compact.replace(/^LoginCookie(?:=|:)?/i, '');
  const decoded = value.includes('%') ? cookieDecode(value) : value;
  const cookie = decoded.replace(/^"+|"+$/g, '');
  if (cookie.length < 20 || cookie.length > 8000 || !COOKIE.test(cookie)) {
    throw new Error('Сессия Author.Today не читается. Скопируйте cookie LoginCookie целиком.');
  }
  return cookie;
}

export function authorTodayChapters(json: unknown): Array<{ id: number; title: string }> {
  const row = record(json);
  const nested = record(row.data);
  const list = Array.isArray(row.chapters) ? row.chapters : Array.isArray(nested.chapters) ? nested.chapters : [];
  const chapters: Array<{ id: number; title: string }> = [];
  for (const item of list) {
    const chapter = record(item);
    const id = whole(chapter.id) || whole(chapter.chapterId);
    const title = text(chapter.title, 200);
    if (id) chapters.push({ id, title });
  }
  return chapters;
}
