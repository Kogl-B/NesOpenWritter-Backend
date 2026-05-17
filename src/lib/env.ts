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
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('Invalid environment variables:');
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
export type Env = typeof env;
