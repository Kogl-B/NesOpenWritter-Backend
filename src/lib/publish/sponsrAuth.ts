import { sponsrProjectsByIds, type SponsrProject } from './sponsrClient.js';
import { sponsrAccount, type SponsrSession } from './sponsrSession.js';

const API = 'https://sponsr.ru/api/v2';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

export interface SponsrIdentity {
  session: SponsrSession;
  name: string;
  projects: SponsrProject[];
}

function cookieHeader(jar: Map<string, string>): string {
  return [...jar].map(([name, value]) => `${name}=${encodeURIComponent(value)}`).join('; ');
}

function takeCookies(res: Response, jar: Map<string, string>) {
  const lines = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  for (const line of lines) {
    const part = line.split(';')[0] ?? '';
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    const raw = part.slice(eq + 1).trim();
    if (!name || !raw) continue;
    try {
      jar.set(name, decodeURIComponent(raw));
    } catch {
      jar.set(name, raw);
    }
  }
}

async function sponsrCall(path: string, jar: Map<string, string>, init: RequestInit = {}): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(`${API}${path}`, {
      ...init,
      headers: {
        accept: 'application/json',
        'user-agent': USER_AGENT,
        origin: 'https://sponsr.ru',
        referer: 'https://sponsr.ru/',
        cookie: cookieHeader(jar),
        ...(init.headers ?? {}),
      },
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new Error('Sponsr не ответил');
  }
  takeCookies(res, jar);
  return res;
}

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

/** Проверяет cookie SESS, берёт токен и проекты этого входа. */
export async function identifySponsr(sess: string): Promise<SponsrIdentity> {
  const jar = new Map<string, string>([['SESS', sess]]);
  // Сайт забирает токен запросом GET. POST этого адреса нет, а csrf/fetch без узнанной сессии подменяет её новой.
  const refresh = await sponsrCall('/auth/refresh-token', jar);
  const refreshJson = await readJson(refresh);
  const code = refreshJson && typeof refreshJson === 'object'
    ? (refreshJson as { message_code?: unknown }).message_code
    : '';
  const token = refreshJson && typeof refreshJson === 'object'
    ? (refreshJson as { data?: { access_token?: unknown } }).data?.access_token
    : '';
  if (!refresh.ok || code !== 'INFO_AUTH' || typeof token !== 'string' || !token) {
    throw new Error('Sponsr не узнал сессию. Скопируйте cookie SESS заново.');
  }

  const profile = await sponsrCall('/profile', jar, {
    headers: { authorization: `Bearer ${token}` },
  });
  const profileJson = await readJson(profile);
  if (!profile.ok) throw new Error('Sponsr не открыл профиль');
  const account = sponsrAccount(profileJson);
  const cards = await sponsrProjectsByIds(account.projectIds.map((project) => project.id));
  const byId = new Map(cards.map((project) => [project.id, project]));
  const projects = account.projectIds.map((project) => {
    const card = byId.get(project.id);
    return {
      id: project.id,
      title: card?.title || `Проект ${project.id}`,
      url: card?.url || '',
      role: project.role,
    };
  });
  const current = jar.get('SESS') || sess;
  return {
    session: { sess: current, accessToken: token },
    name: account.name,
    projects,
  };
}
