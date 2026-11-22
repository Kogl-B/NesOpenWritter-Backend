import { assertKitUrl } from './kit.js';
import {
  boostyAttachments,
  boostyDraftForm,
  boostyImageFrom,
  boostyPostId,
  createdPostFrom,
  type BoostyCreatedPost,
  type BoostyDraft,
  type BoostyImage,
} from './boostyPost.js';
import {
  boostyProfile,
  sessionExpired,
  sessionFromRefresh,
  type BoostySession,
} from './boostySession.js';

const API = 'https://api.boosty.to';
const UPLOAD_HOST = 'https://upload.boosty.to';
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const IMAGE_LIMIT = 8 * 1024 * 1024;
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

export interface BoostyIdentity {
  session: BoostySession;
  name: string;
  blogUrl: string;
}

function headers(session: BoostySession, contentType?: string): Record<string, string> {
  return {
    Accept: 'application/json',
    Authorization: `Bearer ${session.accessToken}`,
    'User-Agent': USER_AGENT,
    ...(contentType ? { 'Content-Type': contentType } : {}),
  };
}

async function refresh(session: BoostySession): Promise<BoostySession> {
  let response: Response;
  try {
    response = await fetch(`${API}/oauth/token/`, {
      method: 'POST',
      headers: headers(session, 'application/x-www-form-urlencoded'),
      body: new URLSearchParams({
        device_id: session.deviceId,
        device_os: 'web',
        grant_type: 'refresh_token',
        refresh_token: session.refreshToken,
      }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new Error('Boosty не ответил. Попробуйте ещё раз.');
  }
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new Error('Boosty не обновил сессию. Войдите на сайт и скопируйте её заново.');
  return sessionFromRefresh(session, body);
}

async function currentUser(session: BoostySession): Promise<{ ok: boolean; status: number; body: unknown }> {
  let response: Response;
  try {
    response = await fetch(`${API}/v1/user/current`, {
      headers: headers(session),
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new Error('Boosty не ответил. Попробуйте ещё раз.');
  }
  const body: unknown = await response.json().catch(() => null);
  return { ok: response.ok, status: response.status, body };
}

/** Проверяет сессию запросом текущего пользователя и при необходимости обновляет токен. */
export async function identifyBoosty(session: BoostySession): Promise<BoostyIdentity> {
  let active = session;
  if (sessionExpired(active.expiresAt)) active = await refresh(active);
  let result = await currentUser(active);
  if (result.status === 401) {
    active = await refresh(active);
    result = await currentUser(active);
  }
  if (!result.ok) {
    throw new Error(result.status === 401
      ? 'Boosty не принял сессию. Войдите на сайт и скопируйте её заново.'
      : 'Boosty не подтвердил сессию. Попробуйте ещё раз.');
  }
  const profile = boostyProfile(result.body);
  let blogUrl = '';
  if (profile.blogUrl) {
    try {
      blogUrl = assertKitUrl('boosty', profile.blogUrl);
    } catch {
      blogUrl = '';
    }
  }
  return { session: active, name: profile.name, blogUrl };
}

function failureText(status: number, body: unknown, fallback: string): string {
  if (status === 401) return 'Boosty не принял сессию. Войдите на сайт и скопируйте её заново.';
  const row = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : null;
  const code = typeof row?.error === 'string' && row.error.length <= 80 ? row.error : '';
  const detail = typeof row?.error_description === 'string' && row.error_description.length <= 140
    ? row.error_description
    : '';
  const extra = [code, detail].filter(Boolean).join(': ');
  return extra ? `${fallback} (${extra})` : fallback;
}

async function send(session: BoostySession, method: string, path: string, form?: URLSearchParams): Promise<{ status: number; body: unknown }> {
  let response: Response;
  try {
    response = await fetch(`${API}${path}`, {
      method,
      headers: headers(session, form ? 'application/x-www-form-urlencoded' : undefined),
      body: form?.toString(),
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new Error('Boosty не ответил. Попробуйте ещё раз.');
  }
  const body: unknown = await response.json().catch(() => null);
  return { status: response.status, body };
}

async function authed(
  session: BoostySession,
  run: (active: BoostySession) => Promise<{ status: number; body: unknown }>,
): Promise<{ session: BoostySession; status: number; body: unknown }> {
  let active = session;
  if (sessionExpired(active.expiresAt)) active = await refresh(active);
  let result = await run(active);
  if (result.status === 401) {
    active = await refresh(active);
    result = await run(active);
  }
  return { session: active, status: result.status, body: result.body };
}

async function publishDraft(session: BoostySession, blog: string, draft: BoostyDraft): Promise<{ status: number; body: unknown }> {
  const saved = await send(session, 'PUT', `/v1/blog/${blog}/post_draft`, boostyDraftForm(draft));
  if (!saved.status || saved.status >= 400) return saved;
  return send(session, 'POST', `/v1/blog/${blog}/post_draft/publish/`, new URLSearchParams({
    is_showcase_visible: 'true',
  }));
}

function posted(result: { session: BoostySession; status: number; body: unknown }, blog: string, fallback: string) {
  if (result.status < 200 || result.status >= 300) {
    throw new Error(failureText(result.status, result.body, fallback));
  }
  return { session: result.session, post: createdPostFrom(result.body, blog) };
}

/** Создаёт бесплатный пост: сначала черновик, затем публикация. */
export async function createBoostyPost(
  session: BoostySession,
  blog: string,
  draft: BoostyDraft,
): Promise<{ session: BoostySession; post: BoostyCreatedPost }> {
  const result = await authed(session, (active) => publishDraft(active, blog, draft));
  return posted(result, blog, 'Boosty не создал пост');
}

/** Заменяет заголовок и содержимое уже опубликованного поста. */
export async function updateBoostyPost(
  session: BoostySession,
  blog: string,
  postId: string,
  draft: BoostyDraft,
): Promise<{ session: BoostySession; post: BoostyCreatedPost }> {
  const id = boostyPostId(postId);
  const result = await authed(session, (active) => send(active, 'PUT', `/v1/blog/${blog}/post/${id}`, boostyDraftForm(draft)));
  if (result.status < 200 || result.status >= 300) {
    throw new Error(failureText(result.status, result.body, 'Boosty не изменил пост'));
  }
  try {
    return { session: result.session, post: createdPostFrom(result.body, blog) };
  } catch {
    return readBoostyPost(result.session, blog, id);
  }
}

/** Читает пост и список прикреплённых фото и ссылок. */
export async function readBoostyPost(
  session: BoostySession,
  blog: string,
  postId: string,
): Promise<{ session: BoostySession; post: BoostyCreatedPost; images: string[]; links: string[] }> {
  const id = boostyPostId(postId);
  const result = await authed(session, (active) => send(active, 'GET', `/v1/blog/${blog}/post/${id}`));
  if (result.status < 200 || result.status >= 300) {
    throw new Error(failureText(result.status, result.body, 'Boosty не отдал пост'));
  }
  return {
    session: result.session,
    post: createdPostFrom(result.body, blog),
    ...boostyAttachments(result.body),
  };
}

function pngSize(bytes: Uint8Array): { width: number; height: number } {
  if (bytes.length < 24 || bytes[0] !== 0x89) return { width: 0, height: 0 };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

async function uploadRequest(
  session: BoostySession,
  url: string,
  init: { method: string; body?: BodyInit; contentType?: string; blog?: string; part?: number },
): Promise<{ status: number; body: unknown }> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: init.method,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${session.accessToken}`,
        'User-Agent': USER_AGENT,
        'X-App': 'web',
        'X-From-Id': session.deviceId,
        Origin: 'https://boosty.to',
        Referer: 'https://boosty.to/',
        ...(init.contentType ? { 'Content-Type': init.contentType } : {}),
        ...(init.blog ? { 'X-Blog': init.blog } : {}),
        ...(init.part ? { 'X-PartNumber': String(init.part) } : {}),
      },
      body: init.body,
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new Error('Boosty не ответил. Попробуйте ещё раз.');
  }
  const body: unknown = await response.json().catch(() => null);
  return { status: response.status, body };
}

function fileIdOf(body: unknown): string {
  const row = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : null;
  const nested = row?.data && typeof row.data === 'object' && !Array.isArray(row.data)
    ? row.data as Record<string, unknown>
    : null;
  const id = nested?.fileId ?? nested?.id ?? row?.fileId ?? row?.id;
  return typeof id === 'string' ? id.trim() : '';
}

/** Загружает фото и возвращает данные, которые можно вложить в пост. */
export async function uploadBoostyImage(
  session: BoostySession,
  file: { bytes: Uint8Array; type: string; name?: string },
  blog = '',
): Promise<{ session: BoostySession; image: BoostyImage }> {
  const type = file.type.toLowerCase();
  if (!IMAGE_TYPES.has(type)) throw new Error('Фото должно быть в формате JPEG, PNG, WebP или GIF');
  if (file.bytes.byteLength === 0 || file.bytes.byteLength > IMAGE_LIMIT) {
    throw new Error('Фото должно быть меньше 8 МБ');
  }
  const uploadOnce = async (active: BoostySession) => {
    const started = await uploadRequest(active, `${UPLOAD_HOST}/image`, {
      method: 'POST',
      contentType: 'application/json',
      body: '{}',
      blog,
    });
    if (started.status === 401 || started.status >= 400) return started;
    const fileId = fileIdOf(started.body);
    if (!fileId) return { status: 502, body: started.body };
    const chunk = await uploadRequest(active, `${UPLOAD_HOST}/upload/${encodeURIComponent(fileId)}`, {
      method: 'POST',
      contentType: 'application/octet-stream',
      body: file.bytes,
      part: 1,
    });
    if (chunk.status === 401 || chunk.status >= 400) return chunk;
    return uploadRequest(active, `${UPLOAD_HOST}/upload/${encodeURIComponent(fileId)}/complete`, {
      method: 'POST',
      contentType: 'application/json',
      body: '{}',
    }).then((done) => done.status >= 200 && done.status < 300
      ? { status: done.status, body: { ...(typeof done.body === 'object' && done.body ? done.body : {}), id: fileId, fileId } }
      : done);
  };
  const result = await authed(session, uploadOnce);
  if (result.status < 200 || result.status >= 300) {
    throw new Error(failureText(result.status, result.body, 'Boosty не принял фото'));
  }
  const id = fileIdOf(result.body);
  const size = pngSize(file.bytes);
  return {
    session: result.session,
    image: boostyImageFrom({
      id,
      width: size.width,
      height: size.height,
      size: file.bytes.byteLength,
    }),
  };
}
