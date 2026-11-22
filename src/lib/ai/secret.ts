import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

import { env } from '../env.js';

const key = scryptSync(env.BETTER_AUTH_SECRET, 'nesow-ai-key', 32);

/** Шифр ключа провайдера. В базе нет открытого секрета. */
export function sealSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64url')}.${tag.toString('base64url')}.${body.toString('base64url')}`;
}

export function openSecret(sealed: string): string {
  const [ivRaw, tagRaw, bodyRaw] = sealed.split('.');
  if (!ivRaw || !tagRaw || !bodyRaw) throw new Error('Ключ ИИ повреждён');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivRaw, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagRaw, 'base64url'));
  const plain = Buffer.concat([decipher.update(Buffer.from(bodyRaw, 'base64url')), decipher.final()]);
  return plain.toString('utf8');
}

export function secretHint(plain: string): string {
  const tail = plain.trim().slice(-4);
  return tail ? `····${tail}` : '';
}
