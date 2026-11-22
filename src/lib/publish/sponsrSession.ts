const TOKEN = /^[\x21-\x7E]+$/;

export interface SponsrSession {
  sess: string;
  accessToken: string;
}

function sessValue(value: string): string {
  const text = value.trim().replace(/^"+|"+$/g, '');
  const decoded = text.includes('%') ? safeDecode(text) : text;
  if (!decoded.startsWith('s:') || !decoded.includes('.') || !TOKEN.test(decoded) || decoded.length < 20 || decoded.length > 4000) {
    throw new Error('Сессия Sponsr не читается. Скопируйте cookie SESS целиком.');
  }
  return decoded;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Значение cookie SESS из строки cookie, заголовка или самого значения. */
export function parseSponsrSess(raw: string): string {
  const text = raw.trim();
  if (!text) throw new Error('Вставьте сессию Sponsr');
  if (text.length > 20_000) throw new Error('Сессия слишком длинная');
  const compact = text.replace(/^\s*cookie\s*:/i, '').replace(/\s+/g, '');
  const match = compact.match(/(?:^|;)SESS=([^;]+)/i);
  const value = match?.[1] ?? compact.replace(/^SESS(?:=|:)?/i, '');
  return sessValue(value);
}

export function sponsrSessionJson(session: SponsrSession): string {
  return JSON.stringify({ sess: session.sess, accessToken: session.accessToken });
}

export function sponsrSessionFromJson(raw: string): SponsrSession {
  let row: unknown;
  try {
    row = JSON.parse(raw);
  } catch {
    throw new Error('Сессия Sponsr повреждена. Подключите её заново.');
  }
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    throw new Error('Сессия Sponsr повреждена. Подключите её заново.');
  }
  const sess = (row as { sess?: unknown }).sess;
  const accessToken = (row as { accessToken?: unknown }).accessToken;
  if (typeof sess !== 'string' || typeof accessToken !== 'string' || !TOKEN.test(accessToken)) {
    throw new Error('Сессия Sponsr повреждена. Подключите её заново.');
  }
  return { sess: parseSponsrSess(sess), accessToken };
}

const ROLES = new Set(['owner', 'project_admin', 'editor', 'moderator', 'accountant', 'coauthor']);

export function sponsrAccount(json: unknown): { name: string; projectIds: Array<{ id: number; role: string }> } {
  const user = userOf(json);
  const name = firstString(user, ['nickname', 'name', 'username', 'login']).slice(0, 80);
  const roles = user.projectRoles ?? user.project_roles;
  const projectIds: Array<{ id: number; role: string }> = [];
  if (roles && typeof roles === 'object' && !Array.isArray(roles)) {
    for (const [key, role] of Object.entries(roles)) {
      const id = Number(key);
      if (!Number.isInteger(id) || id <= 0 || typeof role !== 'string' || !ROLES.has(role)) continue;
      projectIds.push({ id, role });
    }
  }
  projectIds.sort((a, b) => a.id - b.id);
  return { name, projectIds };
}

function userOf(json: unknown): Record<string, unknown> {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return {};
  const row = json as { data?: unknown; user?: unknown };
  const data = row.data && typeof row.data === 'object' && !Array.isArray(row.data) ? row.data as Record<string, unknown> : row as Record<string, unknown>;
  const user = data.user && typeof data.user === 'object' && !Array.isArray(data.user) ? data.user as Record<string, unknown> : data;
  return user;
}

function firstString(row: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}
