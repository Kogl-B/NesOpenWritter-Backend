import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

import { env } from './env.js';
import { logger } from './logger.js';
import { captureError } from './sentry.js';

const prefix = 'ow-drive-v1:';
const key = Buffer.from(hkdfSync('sha256', env.BETTER_AUTH_SECRET, '', 'openwritter/google-drive/token/v1', 32));

type TokenKind = 'access' | 'refresh';

function context(userId: string, kind: TokenKind): Buffer {
  return Buffer.from(JSON.stringify([userId, kind]), 'utf8');
}

export function isStoredDriveTokenEncrypted(value: string): boolean {
  return value.startsWith(prefix);
}

export function sealDriveToken(value: string, userId: string, kind: TokenKind): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(context(userId, kind));
  const bytes = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return prefix + [iv, cipher.getAuthTag(), bytes].map(part => part.toString('base64url')).join('.');
}

export function readDriveToken(value: string, userId: string, kind: TokenKind): string {
  // During rollout the worker can still encounter an older plaintext row.
  if (!isStoredDriveTokenEncrypted(value)) return value;
  try {
    const [iv, tag, body, extra] = value.slice(prefix.length).split('.');
    if (!iv || !tag || !body || extra !== undefined) throw new Error();
    const nonce = Buffer.from(iv, 'base64url');
    const authTag = Buffer.from(tag, 'base64url');
    if (nonce.length !== 12 || authTag.length !== 16) throw new Error();
    const decipher = createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAAD(context(userId, kind));
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    const error = new Error('Google Drive credential failed integrity verification');
    const metadata = { code: 'DRIVE_TOKEN_INTEGRITY_FAILED', userId, kind };
    logger.error(metadata, error.message);
    captureError(error, metadata);
    throw error;
  }
}
