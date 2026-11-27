const TOKEN = /^[\x21-\x7E]+$/;

export interface BoostySession {
  accessToken: string;
  refreshToken: string;
  deviceId: string;
  /** Unix-время в секундах. Пустая строка — срок неизвестен. */
  expiresAt: string;
}

function tokenOf(value: unknown, label: string): string {
  if (typeof value !== 'string' || !TOKEN.test(value)) {
    throw new Error(`${label} должен быть одной строкой без пробелов`);
  }
  return value;
}

export function expiresAtOf(value: unknown): string {
  if (value == null || value === '') return '';
  const raw = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(raw) || raw <= 0) return '';
  const seconds = raw > 1e12 ? Math.floor(raw / 1000) : Math.floor(raw);
  return String(seconds);
}

export function sessionExpired(expiresAt: string, nowMs = Date.now()): boolean {
  if (!expiresAt) return false;
  const exp = Number(expiresAt);
  if (!Number.isFinite(exp)) return false;
  return Math.floor(nowMs / 1000) >= exp - 60;
}

function cookiesOf(header: string): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const part of header.replace(/^\s*cookie\s*:/i, '').split(/;|\r?\n/)) {
    const eq = part.indexOf('=');
    if (eq > 0) cookies[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return cookies;
}

function fromAuthObject(session: Record<string, unknown>, deviceId: string): BoostySession {
  return {
    accessToken: tokenOf(session.accessToken ?? session.access_token, 'Токен доступа'),
    refreshToken: tokenOf(session.refreshToken ?? session.refresh_token, 'Токен обновления'),
    deviceId: tokenOf(deviceId, 'Идентификатор устройства'),
    expiresAt: expiresAtOf(session.expiresAt ?? session.expires_at),
  };
}

function readAuthJson(raw: string): Record<string, unknown> {
  const compact = raw.replace(/\s+/g, '');
  const candidates = [raw, compact];
  for (const source of [raw, compact]) {
    if (!source.includes('%')) continue;
    try {
      candidates.push(decodeURIComponent(source));
    } catch {
      /* в строке есть знак процента, но это не адресная кодировка */
    }
  }
  for (const candidate of candidates) {
    try {
      const session = JSON.parse(candidate) as unknown;
      if (session && typeof session === 'object' && !Array.isArray(session)) {
        return session as Record<string, unknown>;
      }
    } catch {
      /* следующий вариант */
    }
  }
  throw new Error('Сессия Boosty не читается. Скопируйте значение auth целиком.');
}

/** Сессия из объекта auth, обёртки с deviceId или строки cookie браузера. */
export function parseBoostySession(raw: string): BoostySession {
  const text = raw.trim();
  if (!text) throw new Error('Вставьте сессию Boosty');
  if (text.length > 20_000) throw new Error('Сессия слишком длинная');

  if (text.includes('auth=') || text.includes('_clientId=')) {
    const cookies = cookiesOf(text);
    if (!cookies.auth) throw new Error('В строке cookie нет auth');
    if (!cookies._clientId) throw new Error('В строке cookie нет _clientId');
    return fromAuthObject(readAuthJson(cookies.auth), cookies._clientId);
  }

  const row = readAuthJson(text);
  const nested = typeof row.auth === 'string'
    ? readAuthJson(row.auth)
    : row.auth && typeof row.auth === 'object' && !Array.isArray(row.auth)
      ? row.auth as Record<string, unknown>
      : row;
  const device = String(row.deviceId ?? row.device_id ?? row._clientId ?? nested.deviceId ?? nested.device_id ?? '');
  return fromAuthObject(nested, device);
}

export function sessionJson(session: BoostySession): string {
  return JSON.stringify({
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    deviceId: session.deviceId,
    expiresAt: session.expiresAt,
  });
}

export function sessionFromJson(raw: string): BoostySession {
  return parseBoostySession(raw);
}

export function boostyProfile(body: unknown): { name: string; blogUrl: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { name: '', blogUrl: '' };
  const row = body as Record<string, unknown>;
  const name = typeof row.name === 'string' ? row.name.trim().slice(0, 80) : '';
  const blog = typeof row.blogUrl === 'string' ? row.blogUrl.trim() : '';
  if (!blog) return { name, blogUrl: '' };
  if (/^https:\/\//i.test(blog)) return { name, blogUrl: blog };
  return { name, blogUrl: `https://boosty.to/${blog.replace(/^\/+/, '')}` };
}

/** Сессия из ответа входа по почте. Пароль в этот разбор не входит. */
export function boostyLoginSession(json: unknown, deviceId: string): BoostySession {
  const row = json && typeof json === 'object' && !Array.isArray(json) ? json as Record<string, unknown> : {};
  const data = row.data && typeof row.data === 'object' && !Array.isArray(row.data)
    ? row.data as Record<string, unknown>
    : row;
  const expiresIn = Number(data.expires_in ?? data.expiresIn);
  const expiresAt = Number.isFinite(expiresIn) && expiresIn > 0
    ? String(Math.floor(Date.now() / 1000) + Math.floor(expiresIn))
    : expiresAtOf(data.expires_at ?? data.expiresAt);
  const device = typeof data.device_id === 'string' && TOKEN.test(data.device_id) ? data.device_id : deviceId;
  try {
    return {
      accessToken: tokenOf(data.access_token ?? data.accessToken, 'Токен доступа'),
      refreshToken: tokenOf(data.refresh_token ?? data.refreshToken, 'Токен обновления'),
      deviceId: tokenOf(device, 'Идентификатор устройства'),
      expiresAt,
    };
  } catch {
    throw new Error('Boosty не выдал сессию');
  }
}

/** Текст отказа входа. Чужой пароль и токен сюда не попадают. */
export function boostyLoginFailure(status: number, json: unknown): string {
  const row = json && typeof json === 'object' && !Array.isArray(json) ? json as Record<string, unknown> : {};
  const error = typeof row.error === 'string' ? row.error : '';
  const description = typeof row.error_description === 'string' ? row.error_description : '';
  if (status === 404 || error === 'not_found') return 'Boosty не нашёл такой email';
  if (/captcha|recaptcha/i.test(`${error} ${description}`)) {
    return 'Boosty просит проверку «не робот». Вставьте сессию из браузера.';
  }
  const text = description.replace(/\s+/g, ' ').trim().slice(0, 180);
  return text || 'Boosty не пустил';
}

export function sessionFromRefresh(current: BoostySession, body: unknown): BoostySession {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('Boosty не обновил сессию');
  }
  const row = body as Record<string, unknown>;
  const accessToken = tokenOf(row.access_token, 'Токен доступа');
  const refreshToken = tokenOf(row.refresh_token, 'Токен обновления');
  const expiresIn = Number(row.expires_in);
  const expiresAt = Number.isFinite(expiresIn) && expiresIn > 0
    ? String(Math.floor(Date.now() / 1000) + Math.floor(expiresIn))
    : current.expiresAt;
  const device = typeof row.device_id === 'string' && TOKEN.test(row.device_id) ? row.device_id : current.deviceId;
  return { accessToken, refreshToken, deviceId: device, expiresAt };
}
