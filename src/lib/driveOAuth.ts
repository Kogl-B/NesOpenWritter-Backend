import { randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

export const driveOAuthAgeSeconds = 600;
const driveOAuthSchema = z.object({
  state: z.string().min(45).max(512),
  verifier: z.string().length(43),
  sessionId: z.string(),
  origin: z.string().url(),
  expiresAt: z.number(),
});

export function newDriveOAuth(sessionId: string, origin: string) {
  return {
    state: `${randomBytes(32).toString('base64url')}.${Buffer.from(origin).toString('base64url')}`,
    verifier: randomBytes(32).toString('base64url'),
    sessionId,
    origin,
    expiresAt: Date.now() + driveOAuthAgeSeconds * 1000,
  };
}

export function driveReturnOrigin(state: string | null): string | null {
  if (!state || state.length > 512) return null;
  const [nonce, origin, extra] = state.split('.');
  if (nonce?.length !== 43 || !origin || extra !== undefined) return null;
  return Buffer.from(origin, 'base64url').toString();
}

export function readDriveOAuth(value: string | null, state: string | null, sessionId: string | undefined) {
  if (!value || !state || !sessionId) return null;
  try {
    const flow = driveOAuthSchema.parse(JSON.parse(value));
    const expected = Buffer.from(flow.state);
    const received = Buffer.from(state);
    if (flow.sessionId !== sessionId || flow.expiresAt <= Date.now()
        || expected.length !== received.length || !timingSafeEqual(expected, received)) return null;
    return flow;
  } catch {
    return null;
  }
}
