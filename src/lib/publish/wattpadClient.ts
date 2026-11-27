import {
  parseWattpadToken,
  wattpadLoginToken,
  wattpadAuthKey,
  wattpadDeletePartForm,
  wattpadEditPartForm,
  wattpadNewPartForm,
  wattpadPartText,
  wattpadParts,
  wattpadStories,
  wattpadStorySettings,
  wattpadUser,
  wattpadUserId,
  wattpadWriteResult,
  type WattpadPart,
  type WattpadStory,
  type WattpadUser,
} from './wattpad.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const SITE = 'https://www.wattpad.com/api/v3';
const WRITING = 'https://api.wattpad.com/writing/v1';
const ME = 'https://api.wattpad.com/v4/users/me';
const V2 = 'https://www.wattpad.com/apiv2';
const SESSION = 'Wattpad не узнал сессию. Скопируйте cookie token заново.';

export interface WattpadIdentity {
  token: string;
  user: WattpadUser;
  stories: WattpadStory[];
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

function headers(token: string): Record<string, string> {
  return {
    accept: 'application/json',
    'user-agent': UA,
    cookie: `token=${token}`,
  };
}

async function get(token: string, url: string, authKey = ''): Promise<{ status: number; json: unknown }> {
  let res: Response;
  try {
    res = await fetch(url, {
      headers: authKey ? { ...headers(token), authorization: authKey, 'x-requested-with': 'XMLHttpRequest' } : headers(token),
      redirect: 'manual',
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new Error('Wattpad не ответил');
  }
  return { status: res.status, json: await readJson(res) };
}

async function postForm(token: string, url: string, body: Record<string, string>, authKey: string): Promise<{ status: number; json: unknown }> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        ...headers(token),
        authorization: authKey,
        'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'x-requested-with': 'XMLHttpRequest',
        origin: 'https://www.wattpad.com',
        referer: 'https://www.wattpad.com/',
      },
      body: new URLSearchParams(body),
      redirect: 'manual',
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new Error('Wattpad не ответил');
  }
  return { status: res.status, json: await readJson(res) };
}

function rejected(status: number): boolean {
  return status === 301 || status === 302 || status === 401 || status === 403;
}

async function currentUser(token: string): Promise<WattpadUser> {
  const first = await get(token, `${SITE}/internal/current_user?fields=username,name`);
  if (!rejected(first.status)) {
    try {
      return wattpadUser(first.json);
    } catch {
      // запасной адрес ниже
    }
  } else if (first.status !== 404) {
    throw new Error(SESSION);
  }
  const second = await get(token, `${ME}?fields=username,name`);
  if (rejected(second.status)) throw new Error(SESSION);
  if (second.status >= 400) throw new Error('Wattpad не ответил');
  return wattpadUser(second.json);
}

async function ownStories(token: string, username: string): Promise<WattpadStory[]> {
  const writing = await get(token, `${WRITING}/writers/${encodeURIComponent(username)}/stories?taxonomyVersion=0`);
  if (rejected(writing.status)) throw new Error(SESSION);
  if (writing.status < 400) {
    const stories = wattpadStories(writing.json);
    if (stories.length > 0) return stories;
  }
  const published = await get(token, `${SITE}/users/${encodeURIComponent(username)}/stories?fields=stories(id,title,url)`);
  if (rejected(published.status)) throw new Error(SESSION);
  if (published.status >= 400) return [];
  return wattpadStories(published.json);
}

/** Вход по имени и паролю. Дальше используется тот же cookie token. */
export async function loginWattpad(input: { login: string; password: string }): Promise<WattpadIdentity> {
  let res: Response;
  try {
    res = await fetch('https://www.wattpad.com/v4/sessions', {
      method: 'POST',
      headers: {
        'user-agent': UA,
        accept: 'application/json',
        'content-type': 'application/json',
        origin: 'https://www.wattpad.com',
        referer: 'https://www.wattpad.com/login',
      },
      body: JSON.stringify({ type: 'wattpad', username: input.login.trim(), password: input.password }),
      redirect: 'manual',
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new Error('Wattpad не ответил');
  }
  const json = await readJson(res);
  if (!res.ok) {
    let message = 'Wattpad не пустил';
    try {
      wattpadLoginToken(json);
    } catch (err) {
      message = err instanceof Error && err.message !== 'Wattpad не выдал сессию' ? err.message : message;
    }
    throw new Error(message);
  }
  let token = '';
  try {
    token = wattpadLoginToken(json);
  } catch {
    const cookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    const line = cookies.find((item) => /(?:^|;\s*)token=/i.test(item)) ?? '';
    token = line ? parseWattpadToken(line) : '';
  }
  if (!token) throw new Error('Wattpad не выдал сессию');
  return connectWattpad(token);
}

/** Проверяет cookie token и забирает имя и свои истории. */
export async function connectWattpad(paste: string): Promise<WattpadIdentity> {
  const token = parseWattpadToken(paste);
  const user = await currentUser(token);
  const stories = await ownStories(token, user.username);
  return { token, user, stories };
}

let editorKeyCache = '';

async function editorKey(token: string): Promise<string> {
  if (editorKeyCache) return editorKeyCache;
  let res: Response;
  try {
    res = await fetch('https://www.wattpad.com/myworks', {
      headers: { ...headers(token), accept: 'text/html' },
      redirect: 'manual',
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new Error('Wattpad не ответил');
  }
  if (rejected(res.status)) throw new Error(SESSION);
  const html = await res.text();
  editorKeyCache = wattpadAuthKey(html);
  return editorKeyCache;
}

async function storyForWrite(token: string, storyId: number): Promise<{ language: number; category: number; parts: WattpadPart[] }> {
  const result = await get(token, `${SITE}/stories/${storyId}?drafts=1&fields=id,title,language,categories,parts(id,title,url,draft,deleted)`);
  if (rejected(result.status)) throw new Error(SESSION);
  if (result.status >= 400) throw new Error('Wattpad не нашёл историю');
  const settings = wattpadStorySettings(result.json);
  return { ...settings, parts: wattpadParts(result.json) };
}

/** Главы своей истории, включая черновики. */
export async function listWattpadParts(token: string, storyId: number): Promise<WattpadPart[]> {
  return (await storyForWrite(token, storyId)).parts;
}

/** Создаёт главу черновиком и не публикует её. */
export async function createWattpadPart(token: string, input: {
  storyId: number;
  title: string;
  html: string;
}): Promise<{ id: number; textHash: string; url: string }> {
  const story = await storyForWrite(token, input.storyId);
  const key = await editorKey(token);
  const sent = await postForm(token, `${V2}/newstory`, wattpadNewPartForm({
    storyId: input.storyId,
    title: input.title,
    html: input.html,
    language: story.language,
    category: story.category,
  }), key);
  if (rejected(sent.status)) throw new Error(SESSION);
  if (sent.status >= 400) throw new Error('Wattpad не принял главу');
  const saved = wattpadWriteResult(sent.json);
  return { ...saved, url: `https://www.wattpad.com/myworks/${input.storyId}/write/${saved.id}` };
}

/** Меняет заголовок и текст той же главы, оставляя её черновиком. */
export async function updateWattpadPart(token: string, input: {
  storyId: number;
  partId: number;
  title: string;
  html: string;
  textHash: string;
}): Promise<{ id: number; textHash: string }> {
  const story = await storyForWrite(token, input.storyId);
  const key = await editorKey(token);
  const sent = await postForm(token, `${V2}/editstory`, wattpadEditPartForm({
    partId: input.partId,
    storyId: input.storyId,
    title: input.title,
    html: input.html,
    textHash: input.textHash,
    language: story.language,
    category: story.category,
  }), key);
  if (rejected(sent.status)) throw new Error(SESSION);
  if (sent.status >= 400) throw new Error('Wattpad не принял правку');
  const saved = wattpadWriteResult(sent.json);
  if (saved.id !== input.partId) throw new Error('Wattpad сохранил правку в другую главу');
  return saved;
}

/** Читает текст своей главы, чтобы сверить правку. */
export async function readWattpadPart(token: string, partId: number): Promise<{ html: string; textHash: string }> {
  const key = await editorKey(token);
  const result = await get(token, `${V2}/storytext?id=${partId}&output=json`, key);
  if (rejected(result.status)) throw new Error(SESSION);
  if (result.status === 404) throw new Error('Wattpad не нашёл главу');
  if (result.status >= 400) throw new Error('Wattpad не отдал текст главы');
  return wattpadPartText(result.json);
}

/** Удаляет одну свою главу. Историю целиком не трогает. */
export async function deleteWattpadPart(token: string, partId: number): Promise<void> {
  const user = await get(token, `${SITE}/internal/current_user?fields=id,username`);
  if (rejected(user.status)) throw new Error(SESSION);
  if (user.status >= 400) throw new Error('Wattpad не назвал аккаунт');
  const key = await editorKey(token);
  const sent = await postForm(token, `${V2}/deletestory`, wattpadDeletePartForm(partId, wattpadUserId(user.json)), key);
  if (rejected(sent.status)) throw new Error(SESSION);
  if (sent.status >= 400) throw new Error('Wattpad не удалил главу');
  const errors = sent.json && typeof sent.json === 'object' && !Array.isArray(sent.json)
    ? (sent.json as { error_count?: unknown }).error_count
    : 0;
  if (typeof errors === 'number' && errors > 0) throw new Error('Wattpad не удалил главу');
}
