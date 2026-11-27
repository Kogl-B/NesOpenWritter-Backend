export interface WattpadUser {
  username: string;
  name: string;
}

export interface WattpadStory {
  id: number;
  title: string;
  url: string;
}

const TOKEN = /^[\x21-\x7E]{20,4000}$/;

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

/** Токен из ответа входа. Ошибка площадки остаётся её текстом, без пароля. */
export function wattpadLoginToken(json: unknown): string {
  const row = record(json);
  if (row.error_type || row.error_code) {
    throw new Error(text(row.message, 180) || 'Wattpad не пустил');
  }
  const token = text(row.token, 4000)
    || text(record(row.auth).token, 4000)
    || text(record(row.data).token, 4000)
    || text(row.accessToken, 4000);
  if (!token) throw new Error('Wattpad не выдал сессию');
  return parseWattpadToken(token);
}

/** Значение cookie token: само значение, строка cookie или заголовок. */
export function parseWattpadToken(raw: string): string {
  const source = raw.trim();
  if (!source) throw new Error('Вставьте cookie token');
  if (source.length > 20_000) throw new Error('Сессия слишком длинная');
  const compact = source.replace(/^\s*cookie\s*:/i, '').replace(/\s+/g, '');
  const match = compact.match(/(?:^|;)token=([^;]+)/i);
  const value = match?.[1] ?? compact.replace(/^token(?:=|:)?/i, '');
  const decoded = value.includes('%') ? cookieDecode(value) : value;
  const token = decoded.replace(/^"+|"+$/g, '');
  if (!TOKEN.test(token)) throw new Error('Сессия Wattpad не читается. Скопируйте cookie token целиком.');
  return token;
}

export function wattpadSessionJson(token: string): string {
  return JSON.stringify({ token: parseWattpadToken(token) });
}

export function wattpadSessionFromJson(raw: string): string {
  let row: unknown;
  try {
    row = JSON.parse(raw);
  } catch {
    throw new Error('Сессия Wattpad повреждена. Подключите её заново.');
  }
  const token = record(row).token;
  if (typeof token !== 'string') throw new Error('Сессия Wattpad повреждена. Подключите её заново.');
  return parseWattpadToken(token);
}

/** Имя входа. Почту не берёт. */
export function wattpadUser(json: unknown): WattpadUser {
  const row = record(json);
  const nested = record(row.user);
  const source = text(nested.username, 80) ? nested : record(row.data).username ? record(row.data) : row;
  const username = text(source.username, 80);
  const name = text(source.name, 80) || username;
  if (!username || !name) throw new Error('Wattpad не назвал аккаунт');
  return { username, name };
}

function storyUrl(id: number, value: unknown): string {
  const url = text(value, 300);
  if (/^https:\/\/(?:www\.)?wattpad\.com\/story\/\d+/i.test(url)) return url;
  return `https://www.wattpad.com/story/${id}`;
}

export interface WattpadPart {
  id: number;
  title: string;
  url: string;
  draft: boolean;
}

const AUTH_KEY = /apiAuthKey["']?\s*[:=]\s*["']([A-Za-z0-9]{8,64})["']/i;

/** Публичный ключ редактора со страницы сайта. Это не пароль и не cookie. */
export function wattpadAuthKey(html: string): string {
  const key = html.match(AUTH_KEY)?.[1] ?? '';
  if (!key) throw new Error('Wattpad не отдал ключ редактора. Подключите cookie заново.');
  return key;
}

/** Номер своего аккаунта. Почту не берёт. */
export function wattpadUserId(json: unknown): number {
  const row = record(json);
  const nested = record(row.user);
  const id = whole(row.id) || whole(nested.id);
  if (!id) throw new Error('Wattpad не назвал аккаунт');
  return id;
}

/** Язык и первая живая рубрика истории. */
export function wattpadStorySettings(json: unknown): { language: number; category: number } {
  const row = record(json);
  const language = whole(row.language) || whole(record(row.language).id) || 1;
  const categories = Array.isArray(row.categories) ? row.categories : [];
  const category = categories.map(whole).find((id) => id > 0) ?? 5;
  return { language, category };
}

function partUrl(id: number, value: unknown): string {
  const url = text(value, 300);
  if (/^https:\/\/(?:www\.)?wattpad\.com\/\d+/i.test(url)) return url;
  return `https://www.wattpad.com/${id}`;
}

/** Главы своей истории, включая черновики. Текст глав сюда не входит. */
export function wattpadParts(json: unknown): WattpadPart[] {
  const row = record(json);
  const list = Array.isArray(json) ? json : Array.isArray(row.parts) ? row.parts : [];
  const parts: WattpadPart[] = [];
  const seen = new Set<number>();
  for (const item of list) {
    const part = record(item);
    const id = whole(part.id);
    const title = text(part.title, 200);
    if (!id || !title || seen.has(id) || part.deleted === true) continue;
    seen.add(id);
    parts.push({ id, title, url: partUrl(id, part.url), draft: part.draft === true });
  }
  return parts;
}

/** Плоский текст главы в HTML, как его принимает редактор. */
export function wattpadHtml(plain: string): string {
  const rows = plain.replace(/\r\n/g, '\n').split(/\n+/).map((row) => row.trim()).filter(Boolean);
  const source = rows.length > 0 ? rows : [''];
  return source.map((row) => `<p>${row.replace(/[&<>]/g, (char) => (char === '&' ? '&amp;' : char === '<' ? '&lt;' : '&gt;'))}</p>`).join('');
}

/** Новая глава. newstory создаёт часть внутри истории и оставляет её черновиком. */
export function wattpadNewPartForm(input: {
  storyId: number;
  title: string;
  html: string;
  language: number;
  category: number;
}): Record<string, string> {
  return {
    groupid: String(input.storyId),
    title: input.title,
    language: String(input.language),
    copyright: '1',
    category1: String(input.category),
    draft: '1',
    tags: '',
    text: input.html,
    flag1: '0',
    req_type: 'new',
    id: 'new',
    cover_url: '',
    error_count: '0',
    story_url: '',
    skip_title: '0',
  };
}

/** Правка той же главы. textHash — замок из прошлого ответа, его не считают заново. */
export function wattpadEditPartForm(input: {
  partId: number;
  storyId: number;
  title: string;
  html: string;
  textHash: string;
  language: number;
  category: number;
}): Record<string, string> {
  return {
    id: String(input.partId),
    groupid: String(input.storyId),
    req_type: 'edit',
    title: input.title,
    text: input.html,
    last_text_hash: input.textHash,
    category1: String(input.category),
    language: String(input.language),
    skip_title: '0',
    error_count: '0',
    draft: 'true',
  };
}

/** Удаление части. Редактор шлёт новую модель только с номером части и номером автора. */
export function wattpadDeletePartForm(partId: number, authorId: number): Record<string, string> {
  return {
    id: String(partId),
    authorid: String(authorId),
    title: 'Untitled Part 1',
    text: '<p><br></p>',
    copyright: '1',
    flag1: '0',
    groupid: '0',
    req_type: 'new',
    cover_url: '',
    error_count: '0',
    story_url: '',
    skip_title: '0',
  };
}

/** Ответ newstory и editstory: номер главы и замок для следующей правки. */
export function wattpadWriteResult(json: unknown): { id: number; textHash: string } {
  const row = record(json);
  const errors = row.errors;
  const errorCount = typeof row.error_count === 'number' ? row.error_count : 0;
  const hasErrors = Array.isArray(errors) ? errors.length > 0 : Object.keys(record(errors)).length > 0;
  if (errorCount > 0 || hasErrors) throw new Error('Wattpad не принял главу');
  const id = whole(row.id);
  const textHash = text(row.text_hash, 64);
  if (!id || !textHash) throw new Error('Wattpad не вернул номер главы');
  return { id, textHash };
}

/** Текст своей главы и замок правки. */
export function wattpadPartText(json: unknown): { html: string; textHash: string } {
  const row = record(json);
  const html = typeof row.text === 'string' ? row.text : '';
  const textHash = text(row.text_hash, 64);
  if (!textHash) throw new Error('Wattpad не отдал текст главы');
  return { html, textHash };
}

/** Список своих историй. Чужие поля и почту не сохраняет. */
export function wattpadStories(json: unknown): WattpadStory[] {
  const row = record(json);
  const nested = record(row.data);
  const list = Array.isArray(row.stories) ? row.stories : Array.isArray(nested.stories) ? nested.stories : [];
  const stories: WattpadStory[] = [];
  const seen = new Set<number>();
  for (const item of list) {
    const story = record(item);
    const id = whole(story.id) || whole(story.storyId) || whole(story.story_id);
    const title = text(story.title, 200);
    if (!id || !title || seen.has(id)) continue;
    seen.add(id);
    stories.push({ id, title, url: storyUrl(id, story.url) });
  }
  return stories;
}
