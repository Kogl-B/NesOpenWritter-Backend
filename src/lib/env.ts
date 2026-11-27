import { z } from 'zod';
import { config } from 'dotenv';

config();

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(8080),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  DATABASE_URL: z.string().url(),

  CORS_ORIGIN: z.string().default('http://localhost:5173'),

  // email-лист админов (через запятую); пусто = админ-эндпоинты выключены
  ADMIN_EMAILS: z.string().optional().default(''),

  // Отключение email-верификации (для прода без RESEND_API_KEY)
  REQUIRE_EMAIL_VERIFICATION: z.string().optional().default('true'),

  BETTER_AUTH_SECRET: z.string().min(32),
  BETTER_AUTH_URL: z.string().url(),

  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),

  SENTRY_DSN: z
    .string()
    .url()
    .or(z.literal(''))
    .optional()
    .transform((v) => (v === '' ? undefined : v)),

  // Resend (transactional email). Without RESEND_API_KEY the email module
  // logs intent and returns silently — Better-Auth handlers won't crash if
  // email isn't configured yet.
  RESEND_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().default('onboarding@resend.dev'),

  // Public frontend URL — used to build links in emails (verify, reset).
  // In dev set to http://localhost:5173; on Railway set to Vercel domain.
  FRONTEND_URL: z.string().url().default('http://localhost:5173'),

  R2_ACCOUNT_ID: z.string().optional(),
  R2_ACCESS_KEY_ID: z.string().optional(),
  R2_SECRET_ACCESS_KEY: z.string().optional(),
  R2_BUCKET: z.string().optional(),
  R2_PUBLIC_BASE_URL: z
    .string()
    .url()
    .or(z.literal(''))
    .optional()
    .transform((v) => (v === '' ? undefined : v)),

  // Общий секрет Vercel-прокси и API. Пусто — страну берём только по IP.
  GEO_EDGE_TOKEN: z.string().optional().default(''),
  // Только не production: подменить страну посетителя, чтобы проверить ограничение локально.
  GEO_DEV_COUNTRY: z.string().optional().default(''),

  // Общий бот автопоста. Пусто — карточка Telegram на сайте скажет, что бот не настроен.
  TELEGRAM_BOT_TOKEN: z.string().optional().default(''),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('Invalid environment variables:');
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
export type Env = typeof env;

/** localhost и 127.0.0.1 — разные сайты для cookie. Держим оба, иначе вход с одного адреса не виден с другого. */
export function browserOrigins(extra: string[] = []): string[] {
  const out = new Set<string>();
  for (const item of [...env.CORS_ORIGIN.split(','), ...extra]) {
    const origin = item.trim();
    if (!origin) continue;
    out.add(origin);
    try {
      const url = new URL(origin);
      if (url.hostname === 'localhost') url.hostname = '127.0.0.1';
      else if (url.hostname === '127.0.0.1') url.hostname = 'localhost';
      else continue;
      out.add(url.origin);
    } catch {
      /* не URL — оставляем как есть */
    }
  }
  return [...out];
}
