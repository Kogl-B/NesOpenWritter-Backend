import type { SponsrProject } from './sponsrClient.js';
import type { SponsrSession } from './sponsrSession.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

export interface SponsrManageResult {
  id: number;
  url: string;
  sess: string;
}

export function sponsrClock(now = new Date()): string {
  const parts = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Europe/Moscow',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '00';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:00`;
}

export function sponsrManageForm(input: {
  projectId: number;
  postId?: number;
  title: string;
  html: string;
  notify: boolean;
  date: string;
}): URLSearchParams {
  const body = new URLSearchParams();
  if (input.postId) body.set('post_id', String(input.postId));
  body.set('project_id', String(input.projectId));
  body.set('level_id', '');
  body.set('post_text', input.html);
  body.set('post_title', input.title);
  body.set('post_teaser', '');
  body.set('meta_title', '');
  body.set('meta_description', '');
  body.set('post_date', input.date);
  body.set('post_pinned', '0');
  body.set('post_notified', input.notify ? '0' : '1');
  body.set('post_extended_view', '0');
  body.set('set_def_level', '0');
  body.set('post_access_type', 'def');
  body.set('post_access_value', '0');
  body.set('post_status', 'active');
  return body;
}

function slugOf(project: SponsrProject): string {
  try {
    const slug = new URL(project.url).pathname.split('/').filter(Boolean)[0] ?? '';
    if (/^[A-Za-z0-9_-]{1,80}$/.test(slug)) return slug;
  } catch {
    // адрес проекта уже проверен при сохранении
  }
  throw new Error('У проекта Sponsr нет адреса');
}

function cookieHeader(sess: string): string {
  return `SESS=${encodeURIComponent(sess)}`;
}

function rotatedSess(res: Response, current: string): string {
  const lines = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  for (const line of lines) {
    const part = line.split(';')[0] ?? '';
    if (!part.startsWith('SESS=')) continue;
    try {
      const value = decodeURIComponent(part.slice(5));
      if (value.startsWith('s:')) return value;
    } catch {
      // чужая cookie не заменяет сессию
    }
  }
  return current;
}

async function sponsrForm(path: string, sess: string, body: URLSearchParams): Promise<{ res: Response; json: unknown; sess: string }> {
  let res: Response;
  try {
    res = await fetch(`https://sponsr.ru${path}`, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/x-www-form-urlencoded',
        'user-agent': UA,
        origin: 'https://sponsr.ru',
        referer: 'https://sponsr.ru/',
        cookie: cookieHeader(sess),
        e: 'true',
      },
      body,
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new Error('Sponsr не ответил');
  }
  const next = rotatedSess(res, sess);
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { res, json, sess: next };
}

function failure(json: unknown): string {
  if (!json || typeof json !== 'object') return 'Sponsr отклонил пост';
  const error = (json as { error?: unknown }).error;
  if (typeof error === 'string') return error.slice(0, 180);
  if (error && typeof error === 'object') {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim()) return message.trim().slice(0, 180);
    const elements = (error as { elements?: unknown }).elements;
    if (elements && typeof elements === 'object') {
      const text = Object.values(elements).filter((item) => typeof item === 'string').join(' ');
      if (text.trim()) return text.trim().slice(0, 180);
    }
  }
  return 'Sponsr отклонил пост';
}

async function publicUrl(slug: string, postId: number, sess: string): Promise<string> {
  const fallback = `https://sponsr.ru/${slug}/${postId}/`;
  let res: Response;
  try {
    res = await fetch(`https://sponsr.ru/${slug}/manage/post/${postId}/`, {
      headers: {
        accept: 'text/html',
        'user-agent': UA,
        cookie: cookieHeader(sess),
        referer: `https://sponsr.ru/${slug}/`,
      },
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    return fallback;
  }
  const html = await res.text();
  const embedded = html.match(/"post_url":"(\/[A-Za-z0-9_./-]+)"/);
  if (embedded) return `https://sponsr.ru${embedded[1]}`;
  const match = html.match(new RegExp(`/${slug}/${postId}/[A-Za-z0-9_-]+`));
  return match ? `https://sponsr.ru${match[0]}/` : fallback;
}

/** Создаёт или заменяет пост в редакторе Sponsr. Подписчиков зовёт только если это сказано. */
export async function saveSponsrManagePost(session: SponsrSession, input: {
  project: SponsrProject;
  postId?: number;
  title: string;
  html: string;
  notify: boolean;
}): Promise<SponsrManageResult> {
  const slug = slugOf(input.project);
  const suffix = input.postId ? String(input.postId) : 'new';
  const sent = await sponsrForm(
    `/project/${input.project.id}/manage/post-save/${suffix}`,
    session.sess,
    sponsrManageForm({
      projectId: input.project.id,
      postId: input.postId,
      title: input.title,
      html: input.html,
      notify: input.notify,
      date: sponsrClock(),
    }),
  );
  const response = sent.json && typeof sent.json === 'object'
    ? (sent.json as { response?: { post_id?: unknown } }).response
    : null;
  const id = typeof response?.post_id === 'number' ? response.post_id : input.postId;
  if (!sent.res.ok || !id) throw new Error(failure(sent.json));
  return { id, url: await publicUrl(slug, id, sent.sess), sess: sent.sess };
}
