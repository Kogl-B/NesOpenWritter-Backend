import {
  authorTodayChapterBody,
  authorTodayChapterId,
  authorTodayChapterView,
  authorTodayChapters,
  authorTodayLoginGate,
  authorTodayLoginToken,
  authorTodayMessage,
  authorTodayToken,
  parseAuthorTodayCookie,
  authorTodayUser,
  authorTodayWorksPage,
  type AuthorTodayUser,
  type AuthorTodayWork,
} from './authorToday.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const SITE = 'https://author.today';

const TOKEN = /^[\x21-\x7E]+$/;

export interface AuthorTodaySession {
  loginCookie: string;
  token: string;
  expires: string;
}

export function authorTodaySessionJson(session: AuthorTodaySession): string {
  return JSON.stringify({ loginCookie: session.loginCookie, token: session.token, expires: session.expires });
}

export function authorTodaySessionFromJson(raw: string): AuthorTodaySession {
  let row: unknown;
  try {
    row = JSON.parse(raw);
  } catch {
    throw new Error('Сессия Author.Today повреждена. Подключите её заново.');
  }
  const data = row && typeof row === 'object' && !Array.isArray(row) ? row as Record<string, unknown> : {};
  const loginCookie = typeof data.loginCookie === 'string' ? data.loginCookie : '';
  const token = typeof data.token === 'string' ? data.token : '';
  const expires = typeof data.expires === 'string' ? data.expires : '';
  if (loginCookie.length < 10 || !TOKEN.test(token)) {
    throw new Error('Сессия Author.Today повреждена. Подключите её заново.');
  }
  return { loginCookie, token, expires };
}

export interface AuthorTodayIdentity {
  session: AuthorTodaySession;
  user: AuthorTodayUser;
  works: AuthorTodayWork[];
}

function clip(message: string): string {
  return message.replace(/\s+/g, ' ').trim().slice(0, 180);
}

function failure(status: number, json: unknown): Error {
  const message = authorTodayMessage(json);
  if (message) return new Error(clip(message));
  if (status === 401) return new Error('Сессия Author.Today закончилась. Скопируйте cookie LoginCookie заново.');
  return new Error('Author.Today не ответил');
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

async function api(session: AuthorTodaySession, path: string, init: RequestInit = {}): Promise<{ status: number; json: unknown }> {
  const headers = new Headers(init.headers);
  headers.set('user-agent', UA);
  headers.set('accept', 'application/json');
  headers.set('authorization', `Bearer ${session.token}`);
  if (init.body) headers.set('content-type', 'application/json');
  const res = await fetch(`${SITE}/api/${path}`, {
    ...init,
    headers,
    redirect: 'manual',
    signal: AbortSignal.timeout(20_000),
  });
  return { status: res.status, json: await readJson(res) };
}

async function refresh(session: AuthorTodaySession): Promise<AuthorTodaySession> {
  const res = await fetch(`${SITE}/account/bearer-token`, {
    headers: {
      'user-agent': UA,
      accept: 'application/json',
      cookie: `LoginCookie=${session.loginCookie}`,
    },
    redirect: 'manual',
    signal: AbortSignal.timeout(20_000),
  });
  if (res.status === 301 || res.status === 302 || res.status === 401 || res.status === 403) {
    throw new Error('Author.Today не узнал сессию. Скопируйте cookie LoginCookie заново.');
  }
  const json = await readJson(res);
  if (!res.ok) throw failure(res.status, json);
  const token = authorTodayToken(json);
  return { loginCookie: session.loginCookie, token: token.token, expires: token.expires };
}

async function call(session: AuthorTodaySession, path: string, init: RequestInit = {}): Promise<{ session: AuthorTodaySession; json: unknown }> {
  const first = await api(session, path, init);
  if (first.status !== 401) {
    if (first.status >= 400) throw failure(first.status, first.json);
    return { session, json: first.json };
  }
  const next = await refresh(session);
  const second = await api(next, path, init);
  if (second.status >= 400) throw failure(second.status, second.json);
  return { session: next, json: second.json };
}

export class AuthorTodayChallenge extends Error {
  readonly need: 'two_factor' | 'email_code';

  constructor(need: 'two_factor' | 'email_code') {
    super(need === 'two_factor'
      ? 'Author.Today просит код двух факторов'
      : 'Author.Today просит код из письма');
    this.need = need;
  }
}

class CookieJar {
  private readonly jar = new Map<string, string>();

  take(res: Response) {
    const lines = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    for (const line of lines) {
      const pair = line.split(';')[0] ?? '';
      const eq = pair.indexOf('=');
      if (eq <= 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (name && value) this.jar.set(name, value);
    }
  }

  header(): string {
    return [...this.jar].map(([name, value]) => `${name}=${value}`).join('; ');
  }

  get(name: string): string {
    return this.jar.get(name) ?? '';
  }
}

/** Вход по логину и паролю. Дальше сессия та же, что после cookie LoginCookie. */
export async function loginAuthorToday(input: { login: string; password: string; code?: string }): Promise<AuthorTodayIdentity> {
  const jar = new CookieJar();
  const page = await fetch(`${SITE}/account/login`, {
    headers: { 'user-agent': UA, accept: 'text/html' },
    redirect: 'manual',
    signal: AbortSignal.timeout(20_000),
  });
  jar.take(page);
  const token = authorTodayLoginToken(await page.text());
  const form = new FormData();
  form.set('Login', input.login);
  form.set('Password', input.password);
  form.set('RememberMe', 'true');
  form.set('SendEmailIfNeeded', 'false');
  if (input.code?.trim()) form.set('Code', input.code.trim());
  form.set('__RequestVerificationToken', token);
  const posted = await fetch(`${SITE}/account/login`, {
    method: 'POST',
    headers: {
      'user-agent': UA,
      accept: 'application/json',
      origin: SITE,
      referer: `${SITE}/account/login`,
      RequestVerificationToken: token,
      cookie: jar.header(),
    },
    body: form,
    redirect: 'manual',
    signal: AbortSignal.timeout(20_000),
  });
  jar.take(posted);
  const json = await readJson(posted);
  const gate = authorTodayLoginGate(json);
  if (gate !== 'ok') throw new AuthorTodayChallenge(gate);
  const loginCookie = jar.get('LoginCookie');
  if (!loginCookie) throw new Error('Author.Today не выдал сессию');
  return connectAuthorToday(loginCookie);
}

export async function connectAuthorToday(paste: string): Promise<AuthorTodayIdentity> {
  const session = await refresh({ loginCookie: parseAuthorTodayCookie(paste), token: '', expires: '' });
  const user = await call(session, 'v2/account');
  const works = await listAuthorTodayWorks(user.session);
  return {
    session: works.session,
    user: authorTodayUser(user.json),
    works: works.works,
  };
}

export async function listAuthorTodayWorks(session: AuthorTodaySession): Promise<{ session: AuthorTodaySession; works: AuthorTodayWork[] }> {
  const works: AuthorTodayWork[] = [];
  let current = session;
  let page = 1;
  let total = 0;
  do {
    const result = await call(current, `v2/account/works?page=${page}&pageSize=50`);
    current = result.session;
    const parsed = authorTodayWorksPage(result.json);
    total = parsed.total;
    works.push(...parsed.works);
    page += 1;
  } while (works.length < total && page <= 5);
  return { session: current, works };
}

async function chapterIdAfterSave(session: AuthorTodaySession, workId: number, title: string, json: unknown): Promise<{ session: AuthorTodaySession; id: number }> {
  const direct = authorTodayChapterId(json);
  if (direct) return { session, id: direct };
  const listed = await call(session, `v2/work/${workId}/edit/content`);
  const same = authorTodayChapters(listed.json).filter((chapter) => chapter.title === title);
  const id = same.at(-1)?.id ?? 0;
  if (!id) throw new Error('Глава ушла на Author.Today, но номер её не прочитался');
  return { session: listed.session, id };
}

export async function readAuthorTodayChapter(session: AuthorTodaySession, chapterId: number): Promise<{
  session: AuthorTodaySession;
  chapter: { id: number; workId: number; title: string; text: string; draft: boolean } | null;
}> {
  const first = await api(session, `v2/work/edit/chapter/${chapterId}`);
  if (first.status === 404) return { session, chapter: null };
  if (first.status !== 401) {
    if (first.status >= 400) throw failure(first.status, first.json);
    return { session, chapter: authorTodayChapterView(first.json) };
  }
  const next = await refresh(session);
  const second = await api(next, `v2/work/edit/chapter/${chapterId}`);
  if (second.status === 404) return { session: next, chapter: null };
  if (second.status >= 400) throw failure(second.status, second.json);
  return { session: next, chapter: authorTodayChapterView(second.json) };
}

export async function saveAuthorTodayChapter(session: AuthorTodaySession, input: {
  workId: number;
  chapterId?: number;
  title: string;
  html: string;
  draft: boolean;
}): Promise<{ session: AuthorTodaySession; id: number; url: string }> {
  const body = authorTodayChapterBody(input);
  const path = input.chapterId ? 'v2/work/update/chapter' : 'v2/work/create/chapter';
  const saved = await call(session, path, { method: 'POST', body: JSON.stringify(body) });
  const found = await chapterIdAfterSave(saved.session, input.workId, body.title, saved.json);
  return {
    session: found.session,
    id: found.id,
    url: `https://author.today/reader/${input.workId}/${found.id}`,
  };
}
