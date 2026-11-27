import { z } from 'zod';

import { openSecret } from '../ai/secret.js';

/** Шифр из браузера: версия, вектор, тело. Ключ расшифровки на сервер не приходит. */
const SEAL = /^v1\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{24,}$/;

export const vaultBody = z.object({
  platform: z.string().trim().min(1).max(40),
  loginSeal: z.string().regex(SEAL),
  passwordSeal: z.string().regex(SEAL),
}).strict();

export const VAULT_PLATFORMS = [
  'vk',
  'telegram',
  'discord',
  'sponsr',
  'boosty',
  'author_today',
  'litnet',
  'wattpad',
  'patreon',
  'ficbook',
  'rulate',
] as const;

/** В ответ кабинета попадают только площадки с браузерным шифром. Сам шифр сюда не входит. */
export function publicVaultPlatforms(rows: Array<{ platform: string; loginSeal: string; passwordSeal: string }>): string[] {
  return rows
    .filter((row) => SEAL.test(row.loginSeal) && SEAL.test(row.passwordSeal))
    .map((row) => row.platform);
}

/** Площадки, чей пароль запечатан сервером и может взять новый токен. */
export function passwordLoginPlatforms(rows: Array<{ platform: string; loginSeal: string; passwordSeal: string }>): string[] {
  return rows
    .filter((row) => row.loginSeal.length > 0 && row.passwordSeal.length > 0 && !row.loginSeal.startsWith('v1.') && !row.passwordSeal.startsWith('v1.'))
    .map((row) => row.platform);
}

/** Браузерный шифр v1 сервер не открывает. Серверный шифр открывается для нового токена. */
export function serverVault(loginSeal: string, passwordSeal: string): { login: string; password: string } | null {
  if (!loginSeal || !passwordSeal || loginSeal.startsWith('v1.') || passwordSeal.startsWith('v1.')) return null;
  try {
    const login = openSecret(loginSeal);
    const password = openSecret(passwordSeal);
    if (!login || !password) return null;
    return { login, password };
  } catch {
    return null;
  }
}

export function isVaultPlatform(value: string): value is (typeof VAULT_PLATFORMS)[number] {
  return (VAULT_PLATFORMS as readonly string[]).includes(value);
}

export function accessError(err: unknown): string {
  const text = err instanceof Error ? err.message : 'Площадка не ответила';
  return text
    .replace(/bot\d+:[A-Za-z0-9_-]+/gi, 'bot')
    .replace(/access_token=[^&\s]+/gi, 'access_token')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200) || 'Площадка не ответила';
}
