import { createHash } from 'node:crypto';
import { prisma } from './prisma.js';
import { env } from './env.js';
import { logger } from './logger.js';
import { readDriveToken, sealDriveToken } from './driveTokenStorage.js';

/**
 * Google Drive клиента без SDK — OAuth-флоу (drive.file) + загрузка/чтение
 * бэкапов. Файлы живут в папке «OpenWritter Backups» на Диске пользователя.
 */

const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const FOLDER_NAME = 'OpenWritter Backups';

export function isGdriveConfigured(): boolean {
  return Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
}

function redirectUri(origin: string): string {
  return `${origin.replace(/\/$/, '')}/api/integrations/gdrive/callback`;
}

export function getAuthUrl(state: string, verifier: string, origin: string): string {
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID!,
    redirect_uri: redirectUri(origin),
    response_type: 'code',
    scope: `${DRIVE_FILE_SCOPE} https://www.googleapis.com/auth/userinfo.email`,
    access_type: 'offline',
    prompt: 'consent',
    state,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
  });
  return `${AUTH_URL}?${params.toString()}`;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope?: string;
}

async function tokenRequest(body: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    throw Object.assign(new Error(`Google token error: ${res.status}`), {
      statusCode: 502,
    });
  }
  return (await res.json()) as TokenResponse;
}

export interface GdriveTokens {
  accessToken: string;
  email?: string;
}

/** Актуальный access-токен пользователя: из БД + refresh при истечении. */
export async function getValidAccessToken(userId: string): Promise<GdriveTokens> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const integration = await prisma.userIntegration.findUnique({
      where: { userId_provider: { userId, provider: 'gdrive' } },
    });
    if (!integration?.refreshToken) {
      throw Object.assign(new Error('Google Диск не подключён'), { statusCode: 400 });
    }
    const email = integration.email ?? undefined;
    if (integration.accessToken && integration.expiresAt && integration.expiresAt.getTime() > Date.now() + 60_000) {
      return { accessToken: readDriveToken(integration.accessToken, userId, 'access'), email };
    }
    const refresh = readDriveToken(integration.refreshToken, userId, 'refresh');
    const refreshed = await tokenRequest({
      client_id: env.GOOGLE_CLIENT_ID!,
      client_secret: env.GOOGLE_CLIENT_SECRET!,
      grant_type: 'refresh_token',
      refresh_token: refresh,
    });
    const saved = await prisma.userIntegration.updateMany({
      where: {
        id: integration.id, updatedAt: integration.updatedAt,
        accessToken: integration.accessToken, refreshToken: integration.refreshToken,
      },
      data: {
        accessToken: sealDriveToken(refreshed.access_token, userId, 'access'),
        refreshToken: sealDriveToken(refreshed.refresh_token ?? refresh, userId, 'refresh'),
        expiresAt: new Date(Date.now() + refreshed.expires_in * 1000),
      },
    });
    if (saved.count) return { accessToken: refreshed.access_token, email };
  }
  throw Object.assign(new Error('Подключение Google Диска изменилось. Повторите запрос.'), { statusCode: 409 });
}

export async function exchangeCodeAndSave(code: string, userId: string, origin: string, verifier: string): Promise<void> {
  const tokens = await tokenRequest({
    client_id: env.GOOGLE_CLIENT_ID!,
    client_secret: env.GOOGLE_CLIENT_SECRET!,
    grant_type: 'authorization_code',
    code,
    code_verifier: verifier,
    redirect_uri: redirectUri(origin),
  });
  if (!tokens.refresh_token) {
    throw Object.assign(new Error('Google не вернул refresh_token (повторите подключение)'), {
      statusCode: 502,
    });
  }
  // какой аккаунт подключили
  let email: string | undefined;
  try {
    const info = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
    if (info.ok) email = ((await info.json()) as { email?: string }).email;
  } catch {
    /* не критично */
  }
  const accessToken = sealDriveToken(tokens.access_token, userId, 'access');
  const refreshToken = sealDriveToken(tokens.refresh_token, userId, 'refresh');
  await prisma.userIntegration.upsert({
    where: { userId_provider: { userId, provider: 'gdrive' } },
    create: {
      userId,
      provider: 'gdrive',
      accessToken,
      refreshToken,
      expiresAt: new Date(Date.now() + tokens.expires_in * 1000),
      email,
    },
    update: {
      accessToken,
      refreshToken,
      expiresAt: new Date(Date.now() + tokens.expires_in * 1000),
      email,
    },
  });
}

async function driveFetch(
  userId: string,
  url: string,
  init?: RequestInit
): Promise<Response> {
  const { accessToken } = await getValidAccessToken(userId);
  const res = await fetch(url, {
    ...init,
    redirect: 'error',
    signal: AbortSignal.timeout(60_000),
    headers: { ...(init?.headers ?? {}), Authorization: `Bearer ${accessToken}` },
  });
  if (res.status === 401) {
    throw Object.assign(new Error('Доступ к Google Диску отозван — подключите заново'), {
      statusCode: 400,
    });
  }
  if (!res.ok) {
    logger.warn({ code: 'GDRIVE_REQUEST_FAILED', status: res.status }, 'Google Drive request failed');
    throw Object.assign(new Error(`Google Drive error: ${res.status}`), { statusCode: 502 });
  }
  return res;
}

/** Найти/создать папку бэкапов на Диске пользователя. */
async function ensureBackupFolder(userId: string): Promise<string> {
  const q = encodeURIComponent(
    `name='${FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`
  );
  const list = await driveFetch(
    userId,
    `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name)`
  );
  const found = (await list.json()) as { files?: Array<{ id: string }> };
  if (found.files && found.files.length > 0) return found.files[0]!.id;

  const boundary = `nw${Date.now()}`;
  const meta = JSON.stringify({
    name: FOLDER_NAME,
    mimeType: 'application/vnd.google-apps.folder',
  });
  const created = await driveFetch(
    userId,
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id',
    {
      method: 'POST',
      headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
      body: `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}--\r\n`,
    }
  );
  const createdJson = (await created.json()) as { id: string };
  return createdJson.id;
}

export interface DriveFileMeta {
  id: string;
  name: string;
  createdTime?: string;
  size?: string;
}

export async function uploadBackup(
  userId: string,
  fileName: string,
  json: string
): Promise<DriveFileMeta> {
  const folderId = await ensureBackupFolder(userId);
  const boundary = `nw${Date.now()}`;
  const meta = JSON.stringify({ name: fileName, parents: [folderId] });
  const res = await driveFetch(
    userId,
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,createdTime',
    {
      method: 'POST',
      headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
      body:
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n` +
        `--${boundary}\r\nContent-Type: application/json\r\n\r\n${json}\r\n--${boundary}--\r\n`,
    }
  );
  return (await res.json()) as DriveFileMeta;
}

export async function listBackups(userId: string): Promise<DriveFileMeta[]> {
  const folderId = await ensureBackupFolder(userId);
  const q = encodeURIComponent(`'${folderId}' in parents and trashed=false`);
  const res = await driveFetch(
    userId,
    `https://www.googleapis.com/drive/v3/files?q=${q}&orderBy=createdTime desc&fields=files(id,name,createdTime,size)&pageSize=50`
  );
  const data = (await res.json()) as { files?: DriveFileMeta[] };
  return data.files ?? [];
}

export async function downloadFile(userId: string, fileId: string): Promise<string> {
  const res = await driveFetch(
    userId,
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`
  );
  return await res.text();
}
