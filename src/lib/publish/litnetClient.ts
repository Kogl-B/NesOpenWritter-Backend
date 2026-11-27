import {
  litnetBooksPage,
  litnetChapterForm,
  litnetChapterList,
  litnetFormError,
  litnetUser,
  parseLitnetToken,
  type LitnetBook,
  type LitnetChapterRef,
  type LitnetUser,
} from './litnet.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const API = 'https://superapi.litnet.com';
const SITE = 'https://litnet.com';
const TABS = ['novels', 'stories', 'mini'] as const;

export function litnetSessionJson(token: string): string {
  return JSON.stringify({ token: parseLitnetToken(token) });
}

export function litnetSessionFromJson(raw: string): string {
  let row: unknown;
  try {
    row = JSON.parse(raw);
  } catch {
    throw new Error('Сессия Литнета повреждена. Подключите её заново.');
  }
  const token = row && typeof row === 'object' && !Array.isArray(row) ? (row as { token?: unknown }).token : '';
  if (typeof token !== 'string') throw new Error('Сессия Литнета повреждена. Подключите её заново.');
  return parseLitnetToken(token);
}

export interface LitnetIdentity {
  token: string;
  user: LitnetUser;
  books: LitnetBook[];
}

async function readJson(res: Response): Promise<unknown> {
  const raw = await res.text();
  if (!raw) return {};
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return {};
  }
}

async function api(token: string, path: string): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${API}${path}`, {
    headers: {
      'user-agent': UA,
      accept: 'application/json',
      authorization: token,
    },
    redirect: 'manual',
    signal: AbortSignal.timeout(20_000),
  });
  return { status: res.status, json: await readJson(res) };
}

function rejected(status: number): boolean {
  return status === 301 || status === 302 || status === 401 || status === 403;
}

export async function connectLitnet(paste: string): Promise<LitnetIdentity> {
  const token = parseLitnetToken(paste);
  const profile = await api(token, '/v1/account/userinfo');
  if (rejected(profile.status)) {
    throw new Error('Литнет не узнал сессию. Скопируйте cookie _internal_access_token заново.');
  }
  if (profile.status >= 400) throw new Error('Литнет не ответил');
  const books: LitnetBook[] = [];
  const seen = new Set<number>();
  for (const tab of TABS) {
    let offset = 0;
    for (let page = 0; page < 5; page += 1) {
      const result = await api(token, `/v2/account/author-books/tab?tab=${tab}&limit=20&offset=${offset}&sort=default`);
      if (rejected(result.status)) {
        throw new Error('Литнет не узнал сессию. Скопируйте cookie _internal_access_token заново.');
      }
      if (result.status >= 400) break;
      const chunk = litnetBooksPage(result.json);
      for (const book of chunk) {
        if (seen.has(book.id)) continue;
        seen.add(book.id);
        books.push(book);
      }
      if (chunk.length < 20) break;
      offset += chunk.length;
    }
  }
  return { token, user: litnetUser(profile.json), books };
}

export interface LitnetChapterView {
  id: number;
  bookId: number;
  title: string;
  text: string;
  draft: boolean;
}

interface Page {
  status: number;
  location: string;
  html: string;
}

function sessionError(): Error {
  return new Error('Литнет не узнал сессию. Скопируйте cookie _internal_access_token заново.');
}

function absorb(jar: Map<string, string>, res: Response) {
  const lines = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  for (const line of lines) {
    const part = line.split(';')[0] ?? '';
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    jar.set(part.slice(0, eq).trim(), part.slice(eq + 1));
  }
}

function cookieHeader(jar: Map<string, string>): string {
  return [...jar.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
}

function lost(page: Page): boolean {
  if (page.status === 401 || page.status === 403) return true;
  if (page.status !== 301 && page.status !== 302) return false;
  return page.location.includes('/auth/login') || page.location.includes('/ru/health');
}

async function openPage(jar: Map<string, string>, path: string, init?: { method?: string; body?: URLSearchParams; referer?: string }): Promise<Page> {
  const res = await fetch(`${SITE}${path}`, {
    method: init?.method ?? 'GET',
    headers: {
      'user-agent': UA,
      cookie: cookieHeader(jar),
      accept: 'text/html',
      ...(init?.body ? {
        origin: SITE,
        referer: init.referer ?? `${SITE}${path}`,
        'content-type': 'application/x-www-form-urlencoded',
      } : {}),
    },
    body: init?.body,
    redirect: 'manual',
    signal: AbortSignal.timeout(20_000),
  });
  absorb(jar, res);
  return { status: res.status, location: res.headers.get('location') ?? '', html: await res.text() };
}

function chapterFields(csrf: string, title: string, html: string, draft: boolean): URLSearchParams {
  const body = new URLSearchParams();
  body.set('_csrf', csrf);
  body.set('ChapterForm[common]', '');
  body.set('ChapterForm[title]', title);
  body.set('ChapterForm[text]', html);
  body.set('ChapterForm[publish_type]', draft ? '1' : '0');
  body.set('ChapterForm[publishing_date]', '');
  body.set('ChapterForm[user_date]', '');
  body.set('ChapterForm[audio_file_id]', '');
  body.set('ChapterForm[audio_file_jwt]', '');
  body.set('ChapterForm[audio_file_delete]', '0');
  body.set('ChapterForm[confirm_audio_is_actual]', '0');
  return body;
}

async function chaptersOf(jar: Map<string, string>, bookId: number): Promise<LitnetChapterRef[]> {
  const page = await openPage(jar, `/account/novels/view?id=${bookId}`);
  if (lost(page)) throw sessionError();
  if (page.status >= 400) throw new Error('Литнет не открыл книгу');
  return litnetChapterList(page.html);
}

export async function readLitnetChapter(token: string, chapterId: number): Promise<LitnetChapterView | null> {
  const jar = new Map<string, string>([['_internal_access_token', parseLitnetToken(token)]]);
  const page = await openPage(jar, `/account/chapter/edit?id=${chapterId}`);
  if (page.status === 404) return null;
  if (lost(page)) throw sessionError();
  const form = litnetChapterForm(page.html);
  if (!form?.chapterId || form.chapterId !== chapterId) return null;
  return { id: form.chapterId, bookId: form.bookId, title: form.title, text: form.text, draft: form.draft };
}

export async function saveLitnetChapter(token: string, input: {
  bookId: number;
  chapterId?: number;
  title: string;
  html: string;
  draft: boolean;
}): Promise<{ id: number; url: string }> {
  const title = input.title.trim().slice(0, 250);
  const html = input.html.trim().slice(0, 200_000);
  if (title.length < 1) throw new Error('У главы нужно название');
  if (!html) throw new Error('У главы нет текста');
  const jar = new Map<string, string>([['_internal_access_token', parseLitnetToken(token)]]);
  const path = input.chapterId
    ? `/account/chapter/edit?id=${input.chapterId}`
    : `/account/chapter/add?bookId=${input.bookId}`;
  const page = await openPage(jar, path);
  if (lost(page)) throw sessionError();
  const form = litnetChapterForm(page.html);
  if (!form) throw new Error('Литнет не открыл форму главы');
  if (input.chapterId && (form.chapterId !== input.chapterId || form.bookId !== input.bookId)) {
    throw new Error('Эта глава относится к другой книге Литнета');
  }
  const before = input.chapterId ? [] : await chaptersOf(jar, input.bookId);
  const saved = await openPage(jar, path, {
    method: 'POST',
    body: chapterFields(form.csrf, title, html, input.draft),
    referer: `${SITE}${path}`,
  });
  if (lost(saved)) throw sessionError();
  const savedToBook = saved.status === 302 && saved.location.includes('/account/novels/view');
  if (!savedToBook) {
    throw new Error(litnetFormError(saved.html) || 'Литнет не сохранил главу');
  }
  const after = await chaptersOf(jar, input.bookId);
  if (input.chapterId) {
    const found = after.find((chapter) => chapter.id === input.chapterId);
    return { id: input.chapterId, url: found?.url ?? `${SITE}/account/chapter/edit?id=${input.chapterId}` };
  }
  const known = new Set(before.map((chapter) => chapter.id));
  const created = after.filter((chapter) => !known.has(chapter.id));
  const match = created.find((chapter) => chapter.title === title) ?? created.at(-1);
  if (!match) throw new Error('Глава ушла на Литнет, но номер её не прочитался');
  return { id: match.id, url: match.url };
}
