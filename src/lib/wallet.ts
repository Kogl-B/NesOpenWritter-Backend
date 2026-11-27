import { Prisma } from '@prisma/client';
import type { prisma } from './prisma.js';

export function settingsRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function settingsWithWallet(value: unknown, cents: bigint) {
  const settings = settingsRecord(value);
  return { ...settings, wallet: { ...settingsRecord(settings.wallet), balance: Number(cents) / 100 } };
}

export const WALLET_DEBT_ERROR = 'Есть задолженность по возврату платежа. Погасите её на счёте ИИ перед оплатой с основного кошелька.';

export async function lockWallets(db: Pick<typeof prisma, '$queryRaw'>, ids: string[]) {
  return db.$queryRaw<Array<{ id: string; walletBalanceCents: bigint; aiBalanceCents: number }>>`
    SELECT id, "walletBalanceCents", "aiBalanceCents" FROM users
    WHERE id IN (${Prisma.join(ids)}) ORDER BY id FOR UPDATE
  `;
}
