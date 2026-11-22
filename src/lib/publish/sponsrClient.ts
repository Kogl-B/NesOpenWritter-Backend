const API = 'https://sponsr.ru/api/v2/external-api';
const HTTPS = /^https:\/\/[^\s<>"']+$/i;

export type SponsrLevel = { id: number; name: string; projectId?: number };
export type SponsrProject = { id: number; title: string; url: string; role?: string };

function clip(value: string, fallback: string): string {
  const clean = value.replace(/\s+/g, ' ').trim();
  return (clean || fallback).slice(0, 240);
}

function messageOf(json: unknown): string {
  if (!json || typeof json !== 'object') return '';
  const message = (json as { message?: unknown }).message;
  if (typeof message === 'string') return message;
  if (Array.isArray(message)) return message.filter((item) => typeof item === 'string').join(' ');
  return '';
}

/** Русский текст ошибки Sponsr. Ключ в него не попадает. */
export function sponsrFailure(status: number, json: unknown): string {
  if (status === 401) return 'Sponsr не принял ключ';
  if (status === 403) return 'Ключ Sponsr просрочен. Новый запрашивают на api@sponsr.ru';
  const raw = messageOf(json);
  if (/longer than or equal to 4/i.test(raw)) return 'Заголовок Sponsr короче 4 знаков';
  if (/shorter than or equal to 256/i.test(raw)) return 'Заголовок Sponsr длиннее 256 знаков';
  if (/Level Not Found/i.test(raw)) return 'Уровень подписки Sponsr не найден';
  if (/ISO 8601/i.test(raw)) return 'Дата публикации Sponsr не читается';
  return clip(raw, 'Sponsr отклонил запрос');
}

async function sponsrGet(apiKey: string, path: string): Promise<{ status: number; json: unknown }> {
  let res: Response;
  try {
    res = await fetch(`${API}${path}`, {
      headers: { accept: 'application/json', 'X-API-KEY': apiKey },
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new Error('Sponsr не ответил');
  }
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

export async function validateSponsrKey(apiKey: string): Promise<{ expiresAt: string }> {
  const { status, json } = await sponsrGet(apiKey, '/api-keys/validate');
  const row = json && typeof json === 'object' ? json as { valid?: unknown; expires_at?: unknown } : {};
  if (status === 200 && row.valid === true) {
    return { expiresAt: typeof row.expires_at === 'string' ? row.expires_at : '' };
  }
  throw new Error(sponsrFailure(status, json));
}

export async function sponsrLevels(apiKey: string): Promise<SponsrLevel[]> {
  const { status, json } = await sponsrGet(apiKey, '/projects/levels?offset=0&limit=100');
  if (status !== 200) return [];
  const list = json && typeof json === 'object' ? (json as { list?: unknown }).list : null;
  if (!Array.isArray(list)) return [];
  const levels: SponsrLevel[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const row = item as { id?: unknown; project_id?: unknown; level_name?: unknown; level_status?: unknown; level_visible?: unknown };
    if (row.level_status === 'deleted' || row.level_visible === 'hidden') continue;
    if (typeof row.id !== 'number' || !Number.isInteger(row.id) || row.id <= 0) continue;
    const name = typeof row.level_name === 'string' ? row.level_name.trim().slice(0, 80) : '';
    if (!name) continue;
    const projectId = typeof row.project_id === 'number' && Number.isInteger(row.project_id) && row.project_id > 0
      ? row.project_id
      : undefined;
    levels.push({ id: row.id, name, ...(projectId ? { projectId } : {}) });
  }
  return levels;
}

function projectOf(row: unknown): SponsrProject | null {
  if (!row || typeof row !== 'object') return null;
  const item = row as { id?: unknown; project_title?: unknown; project_url?: unknown };
  if (typeof item.id !== 'number' || !Number.isInteger(item.id) || item.id <= 0) return null;
  const title = typeof item.project_title === 'string' ? item.project_title.replace(/\s+/g, ' ').trim().slice(0, 120) : '';
  const slug = typeof item.project_url === 'string' ? item.project_url.trim() : '';
  if (!title || !/^[A-Za-z0-9_-]{1,80}$/.test(slug)) return null;
  return { id: item.id, title, url: `https://sponsr.ru/${slug}` };
}

/** Проекты из ответа Sponsr: один объект data или список list. */
export function sponsrProjectsFrom(json: unknown): SponsrProject[] {
  if (!json || typeof json !== 'object') return [];
  const body = json as { data?: unknown; list?: unknown };
  const rows = Array.isArray(body.list) ? body.list : body.data ? [body.data] : [];
  const projects: SponsrProject[] = [];
  const seen = new Set<number>();
  for (const row of rows) {
    const project = projectOf(row);
    if (!project || seen.has(project.id)) continue;
    seen.add(project.id);
    projects.push(project);
  }
  return projects;
}

async function readProject(id: number): Promise<SponsrProject | null> {
  let res: Response;
  try {
    res = await fetch(`https://sponsr.ru/api/v2/content/projects/${id}`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    return null;
  }
  return sponsrProjectsFrom(json).find((project) => project.id === id) ?? null;
}

export async function sponsrProjectsByIds(ids: number[]): Promise<SponsrProject[]> {
  const named: SponsrProject[] = [];
  for (const id of [...new Set(ids)].slice(0, 20)) {
    const project = await readProject(id);
    if (project) named.push(project);
  }
  return named;
}

/** Проекты, которые открывает уже проверенный ключ. Ключ в адрес не попадает. */
export async function loadSponsrProjects(apiKey: string, levels: SponsrLevel[]): Promise<SponsrProject[]> {
  const ids = levels.flatMap((level) => level.projectId ? [level.projectId] : []);
  const named = await sponsrProjectsByIds(ids);
  if (named.length > 0) return named;
  let res: Response;
  try {
    res = await fetch('https://sponsr.ru/api/v2/content/projects?withoutPagination=true', {
      headers: { accept: 'application/json', 'X-API-KEY': apiKey },
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    return [];
  }
  if (!res.ok) return [];
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    return [];
  }
  const list = sponsrProjectsFrom(json);
  return list.length > 0 && list.length <= 20 ? list : [];
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function httpsUrl(value: string | undefined): string {
  const url = (value ?? '').trim();
  return HTTPS.test(url) && url.length <= 500 ? url : '';
}

export function plainSponsr(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => `<p>${escapeHtml(part).replace(/\n/g, '<br>')}</p>`)
    .join('\n');
}

/** HTML поста: уже собранный текст, ссылки и картинки по https. */
export function sponsrDocument(input: {
  body?: string;
  url?: string;
  links?: Array<{ url: string; title?: string }>;
  images?: Array<{ url: string; alt?: string }>;
}, limit = 150_000): string {
  const parts: string[] = [];
  const read = httpsUrl(input.url);
  if (read) parts.push(`<p><a href="${escapeHtml(read)}">Читать на сайте</a></p>`);
  const body = (input.body ?? '').trim();
  if (body) parts.push(body.slice(0, limit));
  for (const link of input.links ?? []) {
    const url = httpsUrl(link.url);
    if (!url) continue;
    const title = (link.title ?? '').trim() || url;
    parts.push(`<p><a href="${escapeHtml(url)}">${escapeHtml(title)}</a></p>`);
  }
  for (const image of input.images ?? []) {
    const url = httpsUrl(image.url);
    if (!url) continue;
    const alt = (image.alt ?? '').trim().slice(0, 200);
    parts.push(`<p><img src="${escapeHtml(url)}" alt="${escapeHtml(alt)}"></p>`);
  }
  const html = parts.join('\n');
  return html.length > limit ? html.slice(0, limit) : html;
}

export function sponsrPostBody(input: {
  title: string;
  html: string;
  date: string;
  levelId?: number | null;
  notify?: boolean;
}): Record<string, unknown> {
  const body: Record<string, unknown> = {
    date: input.date,
    title: input.title,
    text: input.html,
    is_extended_view: true,
    is_pinned: false,
    is_markdown: false,
    is_notified: input.notify === false,
  };
  if (typeof input.levelId === 'number' && input.levelId > 0) body.level_id = input.levelId;
  return body;
}
