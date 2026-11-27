import { HeadObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import { env } from './env.js';

let cachedClient: S3Client | null = null;

function getClient(): S3Client {
  if (cachedClient) return cachedClient;
  if (
    !env.R2_ACCOUNT_ID ||
    !env.R2_ACCESS_KEY_ID ||
    !env.R2_SECRET_ACCESS_KEY ||
    !env.R2_BUCKET
  ) {
    throw Object.assign(new Error('R2 not configured'), { statusCode: 503 });
  }
  cachedClient = new S3Client({
    region: 'auto',
    endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: env.R2_ACCESS_KEY_ID,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    },
    // Новые @aws-sdk вписывают x-amz-checksum-* в подпись presign-URL, но
    // браузер/curl при PUT эти заголовки не шлёт → SignatureDoesNotMatch.
    // Для S3-совместимых хранилищ (R2) чексаммы не нужны.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
  return cachedClient;
}

export function isR2Configured(): boolean {
  return Boolean(
    env.R2_ACCOUNT_ID &&
      env.R2_ACCESS_KEY_ID &&
      env.R2_SECRET_ACCESS_KEY &&
      env.R2_BUCKET,
  );
}

export interface PresignedUpload {
  uploadUrl: string;
  key: string;
  publicUrl: string | null;
  expiresIn: number;
}

export async function presignUpload(opts: {
  projectId: string;
  userId: string;
  kind: string;
  filename: string;
  contentType: string;
}): Promise<PresignedUpload> {
  const client = getClient();
  const safeName = opts.filename.replace(/[^a-zA-Z0-9._-]/g, '_');
  const key = `users/${opts.userId}/projects/${opts.projectId}/${opts.kind}/${Date.now()}-${safeName}`;

  const command = new PutObjectCommand({
    Bucket: env.R2_BUCKET,
    Key: key,
    ContentType: opts.contentType,
  });

  const expiresIn = 600; // 10 min
  const uploadUrl = await getSignedUrl(client, command, { expiresIn });

  const publicUrl = env.R2_PUBLIC_BASE_URL
    ? `${env.R2_PUBLIC_BASE_URL.replace(/\/$/, '')}/${key}`
    : null;

  return { uploadUrl, key, publicUrl, expiresIn };
}

export function publicObjectUrl(key: string): string | null {
  if (!env.R2_PUBLIC_BASE_URL) return null;
  return `${env.R2_PUBLIC_BASE_URL.replace(/\/$/, '')}/${key}`;
}

/** Кадр кабинета без книги: users/{id}/photos/{файл}. */
export function isPersonalPhotoKey(userId: string, key: string): boolean {
  const prefix = `users/${userId}/photos/`;
  return key.startsWith(prefix) && !key.slice(prefix.length).includes('/') && !key.includes('..') && !key.includes('\\');
}

export async function presignPersonalUpload(opts: {
  userId: string;
  filename: string;
  contentType: string;
}): Promise<PresignedUpload> {
  const safeName = opts.filename.replace(/[^a-zA-Z0-9._-]/g, '_') || 'photo.jpg';
  const key = `users/${opts.userId}/photos/${Date.now()}-${safeName}`;
  const command = new PutObjectCommand({
    Bucket: env.R2_BUCKET,
    Key: key,
    ContentType: opts.contentType,
  });
  const expiresIn = 600;
  const uploadUrl = await getSignedUrl(getClient(), command, { expiresIn });
  return { uploadUrl, key, publicUrl: publicObjectUrl(key), expiresIn };
}

/** Кладёт байты сам и возвращает публичный адрес. Без адреса результат генерации некуда отдать. */
export async function putPublicObject(opts: {
  userId: string;
  projectId: string;
  kind: string;
  filename: string;
  contentType: string;
  body: Buffer;
}): Promise<{ key: string; publicUrl: string }> {
  if (!isR2Configured() || !env.R2_PUBLIC_BASE_URL) {
    throw Object.assign(new Error('Хранилище картинок не настроено'), { statusCode: 503 });
  }
  const safeName = opts.filename.replace(/[^a-zA-Z0-9._-]/g, '_') || 'photo.jpg';
  const key = `users/${opts.userId}/projects/${opts.projectId}/${opts.kind}/${Date.now()}-${safeName}`;
  await getClient().send(new PutObjectCommand({
    Bucket: env.R2_BUCKET,
    Key: key,
    ContentType: opts.contentType,
    Body: opts.body,
  }));
  return {
    key,
    publicUrl: `${env.R2_PUBLIC_BASE_URL.replace(/\/$/, '')}/${key}`,
  };
}

/** Фактический размер объекта. null — объекта нет. */
export async function objectSizeBytes(key: string): Promise<number | null> {
  try {
    const head = await getClient().send(new HeadObjectCommand({
      Bucket: env.R2_BUCKET,
      Key: key,
    }));
    return typeof head.ContentLength === 'number' ? head.ContentLength : null;
  } catch {
    return null;
  }
}

/** Все объекты кабинета аккаунта. Размер берётся из списка, без отдельного запроса на файл. */
export async function listUserObjects(userId: string): Promise<Array<{ key: string; sizeBytes: number }>> {
  if (!isR2Configured()) return [];
  const found: Array<{ key: string; sizeBytes: number }> = [];
  let token: string | undefined;
  do {
    const page = await getClient().send(new ListObjectsV2Command({
      Bucket: env.R2_BUCKET,
      Prefix: `users/${userId}/`,
      ContinuationToken: token,
    }));
    for (const item of page.Contents ?? []) {
      if (item.Key && typeof item.Size === 'number' && item.Size >= 0) {
        found.push({ key: item.Key, sizeBytes: item.Size });
      }
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  return found;
}
