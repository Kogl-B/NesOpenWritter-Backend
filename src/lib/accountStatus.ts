import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { env } from './env.js';
import { prisma } from './prisma.js';

export const ACCOUNT_STATUSES = ['test', 'regular', 'admin'] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

export function isAccountStatus(value: unknown): value is AccountStatus {
  return typeof value === 'string' && (ACCOUNT_STATUSES as readonly string[]).includes(value);
}

export function emailIsBootstrapAdmin(email: string | null | undefined): boolean {
  if (!email || !env.ADMIN_EMAILS) return false;
  const list = env.ADMIN_EMAILS.split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  return list.includes(email.toLowerCase());
}

export const STATUS_CATALOG: Record<AccountStatus, { title: string; rights: string[] }> = {
  test: {
    title: 'Тестовый',
    rights: [
      'Ведёт свои проекты',
      'Штатный ИИ в пределах тестовой квоты',
      'Админка закрыта',
    ],
  },
  regular: {
    title: 'Обычный',
    rights: [
      'Ведёт свои проекты',
      'Штатный ИИ в пределах обычной квоты',
      'Админка закрыта',
    ],
  },
  admin: {
    title: 'Админский',
    rights: [
      'Всё, что может обычный аккаунт',
      'Статистика, аккаунты и смена их статуса',
      'Ключи DeepSeek и OpenAI Image 2.5, цены учёта и квоты',
      'Сообщения об ошибках от пользователей',
      'ИИ без потолка, пока квота админа равна нулю',
    ],
  },
};

/** Статус из базы. Почта из ADMIN_EMAILS один раз поднимается до админского. */
export async function resolveAccountStatus(userId: string, email: string | null | undefined): Promise<AccountStatus> {
  const row = await prisma.user.findUnique({
    where: { id: userId },
    select: { accountStatus: true, email: true, emailVerified: true },
  });
  const stored = isAccountStatus(row?.accountStatus) ? row.accountStatus : 'test';
  if (stored !== 'admin' && row?.emailVerified && row.email === email && emailIsBootstrapAdmin(row.email)) {
    await prisma.user.update({ where: { id: userId }, data: { accountStatus: 'admin' } });
    return 'admin';
  }
  return stored;
}

export async function requireAdmin(app: FastifyInstance, req: FastifyRequest, reply: FastifyReply): Promise<boolean> {
  app.requireAuth(req);
  const status = await resolveAccountStatus(req.user!.id, req.user!.email);
  if (status !== 'admin') {
    reply.status(403).send({ error: 'Нужен админский аккаунт' });
    return false;
  }
  return true;
}
