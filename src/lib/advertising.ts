import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { env } from './env.js';

export const placements = ['site-banner', 'reader-note', 'projects-banner'] as const;
export const placementSchema = z.enum(placements);
export const eventPlacementSchema = z.enum([...placements, 'post']);
export const currencySchema = z.enum(['RUB', 'BYN', 'USD', 'EUR']);
const payloadSchema = z.object({
  id: z.string().uuid(), postId: z.string().min(1).max(64), placement: eventPlacementSchema,
  issuedAt: z.number().int(),
});
const ttl = 24 * 3600_000;

function sign(value: string): Buffer {
  return createHmac('sha256', env.BETTER_AUTH_SECRET).update('ad-exposure-v1:').update(value).digest();
}

export function exposureToken(postId: string, placement: z.infer<typeof eventPlacementSchema>, now = Date.now()): string {
  const data = Buffer.from(JSON.stringify({ id: randomUUID(), postId, placement, issuedAt: now })).toString('base64url');
  return data + '.' + sign(data).toString('base64url');
}

export function readExposureToken(token: string, now = Date.now()) {
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const [data, signature] = parts as [string, string];
  const received = Buffer.from(signature, 'base64url');
  const expected = sign(data);
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) return null;
  try {
    const payload = payloadSchema.parse(JSON.parse(Buffer.from(data, 'base64url').toString('utf8')));
    return payload.issuedAt <= now && now - payload.issuedAt <= ttl ? payload : null;
  } catch {
    return null;
  }
}

export function livePostFilter(now = new Date()) {
  return { state: 'active', paidAt: { not: null }, startsAt: { lte: now }, endsAt: { gt: now } };
}

export function externalAdLink(value: string): boolean {
  if (value === '') return true;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch {
    return false;
  }
}
