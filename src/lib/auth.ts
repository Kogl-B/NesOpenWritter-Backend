import { betterAuth } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import { twoFactor } from 'better-auth/plugins';

import { env } from './env.js';
import { prisma } from './prisma.js';
import {
  sendPasswordResetEmail,
  sendTwoFactorDisabledEmail,
  sendTwoFactorEnabledEmail,
  sendVerificationEmail,
} from './email.js';
import { logger } from './logger.js';

const isProd = env.NODE_ENV === 'production';

/**
 * Better-Auth builds links pointing at the backend (`/api/auth/...`). We
 * want the user to land on the *frontend* after the token is checked, so
 * we append `callbackURL=<frontend page>` to the link. Better-Auth reads
 * it and redirects there after marking the token as used.
 */
function appendCallbackUrl(authUrl: string, callbackPage: string): string {
  const separator = authUrl.includes('?') ? '&' : '?';
  return `${authUrl}${separator}callbackURL=${encodeURIComponent(callbackPage)}`;
}

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
    // Hard email verification: sign-up returns no session until the user
    // clicks the verification link in the email. Sign-in on an unverified
    // account returns EMAIL_NOT_VERIFIED (the frontend must catch this and
    // surface a "check your inbox / resend" UI).
    requireEmailVerification: true,
    minPasswordLength: 8,
    sendResetPassword: async ({ user, url }) => {
      // Better-Auth builds url as <baseURL>/reset-password?token=...
      // Better-Auth's default points at the backend; we want the *frontend*
      // page to handle it. Redirect via the verify-email callbackURL trick:
      // append &callbackURL=<frontend>/reset-password so after token check
      // the user lands on the frontend with the token in URL.
      const finalUrl = appendCallbackUrl(url, `${env.FRONTEND_URL}/reset-password`);
      await sendPasswordResetEmail({ to: user.email, resetUrl: finalUrl });
    },
  },

  emailVerification: {
    sendOnSignUp: true,
    autoSignInAfterVerification: true,
    sendVerificationEmail: async ({ user, url }) => {
      const finalUrl = appendCallbackUrl(url, `${env.FRONTEND_URL}/email-verified`);
      await sendVerificationEmail({ to: user.email, verifyUrl: finalUrl });
    },
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

  plugins: [
    twoFactor({
      issuer: 'NesOpenWritter',
      // backup codes: 10 single-use codes generated at enable time
      backupCodeOptions: { amount: 10, length: 10 },
    }),
  ],

  databaseHooks: {
    user: {
      update: {
        before: async (data, ctx) => {
          // Stash the *previous* twoFactorEnabled on ctx so the `after`
          // hook can detect a real transition rather than firing on every
          // user update (name change, etc).
          if (ctx && (data as { twoFactorEnabled?: unknown }).twoFactorEnabled !== undefined) {
            const userId = ctx.context?.session?.user?.id;
            if (userId) {
              const prev = await prisma.user.findUnique({
                where: { id: userId },
                select: { twoFactorEnabled: true },
              });
              (ctx as unknown as { _prev2FA?: boolean })._prev2FA = prev?.twoFactorEnabled ?? false;
            }
          }
        },
        after: async (user, ctx) => {
          const prev = (ctx as unknown as { _prev2FA?: boolean })?._prev2FA;
          if (prev === undefined) return;
          if (typeof user.twoFactorEnabled !== 'boolean' || !user.email) return;
          if (user.twoFactorEnabled === prev) return; // no real transition
          try {
            if (user.twoFactorEnabled) {
              await sendTwoFactorEnabledEmail({ to: user.email });
            } else {
              await sendTwoFactorDisabledEmail({ to: user.email });
            }
          } catch (err) {
            logger.error({ err, userId: user.id }, '2FA notification email failed');
          }
        },
      },
    },
  },
});
