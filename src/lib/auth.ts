import { betterAuth } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';

import { env } from './env.js';
import { prisma } from './prisma.js';

const isProd = env.NODE_ENV === 'production';

// trustedOrigins: every Vercel/custom domain (from CORS_ORIGIN) plus the
// backend's own URL — proxy setups sometimes pass Origin as the backend
// host, and same-origin checks from server-side rendering need it too.
const trustedOrigins = Array.from(
  new Set([
    ...env.CORS_ORIGIN.split(',').map((o) => o.trim()).filter(Boolean),
    env.BETTER_AUTH_URL,
  ]),
);

const socialProviders =
  env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
    ? {
        google: {
          clientId: env.GOOGLE_CLIENT_ID,
          clientSecret: env.GOOGLE_CLIENT_SECRET,
        },
      }
    : undefined;

export const auth = betterAuth({
  database: prismaAdapter(prisma, { provider: 'postgresql' }),
  secret: env.BETTER_AUTH_SECRET,
  baseURL: env.BETTER_AUTH_URL,
  trustedOrigins,

  emailAndPassword: {
    enabled: true,
    autoSignIn: true,
    requireEmailVerification: false,
    minPasswordLength: 8,
  },

  ...(socialProviders && { socialProviders }),

  session: {
    expiresIn: 60 * 60 * 24 * 30,
    updateAge: 60 * 60 * 24,
    cookieCache: { enabled: true, maxAge: 60 * 5 },
  },

  advanced: {
    cookiePrefix: 'nesow',
    useSecureCookies: isProd,
    defaultCookieAttributes: {
      sameSite: isProd ? 'none' : 'lax',
      secure: isProd,
      httpOnly: true,
    },
  },
});
