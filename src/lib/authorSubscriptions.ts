import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { getRates, bynPerUnit, type RateInfo } from './currency.js';
import { prisma } from './prisma.js';
import { lockWallets, WALLET_DEBT_ERROR } from './wallet.js';
import { nextSubscriptionMonth } from './subscriptionPeriod.js';
export { nextSubscriptionMonth } from './subscriptionPeriod.js';

export const cancellationReasons = ['price', 'content', 'rarely_read', 'other'] as const;
export const paymentSchema = z.object({
  requestId: z.string().uuid(), amountCents: z.number().int().positive().max(100_000_000), priceRub: z.number().int().positive().max(100_000),
});
type Payment = z.infer<typeof paymentSchema>;
type Level = { id: string; priceRub: number; title: string; available: boolean };
type Tx = Pick<typeof prisma, '$queryRaw' | 'authorSubscription' | 'blogAudienceEvent' | 'user'>;
type AccessInput = { authorId: string; userId: string; levelId: string | null; managed?: boolean; reason?: string };

export function activeAuthors(now = new Date()): Prisma.AuthorSubscriptionWhereInput {
  return { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] };
}

export function authorCharge(priceRub: number, rate: RateInfo) {
  const cents = Math.round(priceRub * bynPerUnit(rate) * 100);
  return Number.isSafeInteger(cents) && cents > 0 && cents <= 100_000_000 ? cents : 0;
}

export async function lockLevel(db: Pick<typeof prisma, '$queryRaw'>, authorId: string, id: string) {
  const [level] = await db.$queryRaw<Level[]>`
    SELECT id, title, "priceRub", available FROM author_levels
    WHERE id = ${id} AND "authorId" = ${authorId} FOR UPDATE
  `;
  return level;
}

function subscriptionKey(authorId: string, userId: string) {
  return { userId_authorId: { userId, authorId } };
}

function failure(status: number, error: string) {
  return { status, error };
}

export async function changeAuthorAccess({ authorId, userId, levelId, managed, reason = '' }: AccessInput) {
  if (authorId === userId) return failure(400, 'Нельзя оформить подписку на себя.');
  return prisma.$transaction(async (tx) => {
    if ((await lockWallets(tx, [authorId, userId])).length !== 2) return failure(404, 'Пользователь не найден.');
    const where = subscriptionKey(authorId, userId);
    const current = await tx.authorSubscription.findUnique({ where, include: { level: true } });
    const paid = current?.expiresAt && current.expiresAt > new Date();
    if (paid && (managed || levelId)) return failure(409, 'У читателя действует оплаченный период. Изменить доступ можно после его окончания.');
    if (levelId === null) {
      if (!current || current.cancelledAt) return { status: 200 };
      if (paid) {
        await tx.authorSubscription.update({ where, data: { cancelledAt: new Date() } });
      } else {
        await tx.authorSubscription.delete({ where });
      }
      await tx.blogAudienceEvent.create({ data: {
        authorId, userId, kind: 'cancelled', reason, levelId: current.levelId,
        levelTitle: current.level.title, priceRub: current.level.priceRub, expiresAt: paid ? current.expiresAt : null,
      } });
      return { status: 200 };
    }
    const level = await lockLevel(tx, authorId, levelId);
    if (!level) return failure(404, 'Уровень не найден.');
    if (!managed && !level.available) return failure(409, 'Приём новых подписчиков закрыт.');
    if (!managed && level.priceRub > 0) return failure(409, 'Подтвердите оплату уровня через кошелёк.');
    if (current?.levelId === levelId && !current.expiresAt) return { status: 200 };
    await tx.authorSubscription.upsert({
      where,
      create: { authorId, userId, levelId },
      update: { levelId, expiresAt: null, cancelledAt: null, ...(current?.expiresAt && { createdAt: new Date() }) },
    });
    const kind = current && !current.expiresAt ? (level.priceRub > current.level.priceRub ? 'upgraded' : 'changed') : 'joined';
    await tx.blogAudienceEvent.create({ data: {
      authorId, userId, kind, levelId, levelTitle: level.title, priceRub: level.priceRub,
    } });
    return { status: 200 };
  });
}

async function rateForPurchase() {
  const rates = await getRates();
  return rates.stale ? null : rates.RUB;
}

export async function quoteAuthorSubscription(authorId: string, userId: string, levelId: string) {
  const level = await prisma.authorLevel.findFirst({ where: { id: levelId, authorId, available: true, priceRub: { gt: 0 } } });
  if (!level || authorId === userId) return failure(404, 'Уровень недоступен.');
  const rate = await rateForPurchase();
  const amountCents = rate ? authorCharge(level.priceRub, rate) : 0;
  if (!amountCents) return failure(503, 'Курс для оплаты сейчас недоступен. Попробуйте позже.');
  return { status: 200, quote: { amountCents, priceRub: level.priceRub } };
}

async function checkReceipt(db: Pick<Tx, 'blogAudienceEvent'>, input: Required<Pick<AccessInput, 'authorId' | 'userId'>> & { levelId: string }, payment: Payment) {
  const event = await db.blogAudienceEvent.findUnique({
    where: { userId_requestId: { userId: input.userId, requestId: payment.requestId } },
  });
  if (!event) return null;
  if (event.authorId !== input.authorId || event.levelId !== input.levelId ||
    event.amountCents !== payment.amountCents || event.priceRub !== payment.priceRub) {
    return failure(409, 'Этот запрос уже использован для другого платежа.');
  }
  return { status: 200, paymentId: event.id, expiresAt: event.expiresAt };
}

export async function buyAuthorSubscription(input: { authorId: string; userId: string; levelId: string }, payment: Payment) {
  const { authorId, userId, levelId } = input;
  if (authorId === userId) return failure(400, 'Нельзя оформить подписку на себя.');
  const existing = await checkReceipt(prisma, input, payment);
  if (existing) return existing;
  const rate = await rateForPurchase();
  if (!rate) return failure(503, 'Курс для оплаты сейчас недоступен. Попробуйте позже.');
  return prisma.$transaction(async (tx) => {
    const wallets = await lockWallets(tx, [authorId, userId]);
    const receipt = await checkReceipt(tx, input, payment);
    if (receipt) return receipt;
    const level = await lockLevel(tx, authorId, levelId);
    if (wallets.length !== 2 || !level || !level.available || level.priceRub <= 0) return failure(404, 'Уровень недоступен.');
    const amount = authorCharge(level.priceRub, rate);
    if (!amount || level.priceRub !== payment.priceRub || amount !== payment.amountCents) {
      return failure(409, 'Цена или курс изменились. Проверьте сумму и подтвердите ещё раз.');
    }
    const now = new Date();
    const where = subscriptionKey(authorId, userId);
    const current = await tx.authorSubscription.findUnique({ where, include: { level: true } });
    const remaining = current?.expiresAt && current.expiresAt > now ? current.expiresAt : null;
    if (remaining && current?.levelId !== levelId && level.priceRub <= current!.level.priceRub) {
      return failure(409, 'Пока действует оплаченный период, можно продлить текущий уровень или перейти на более высокий.');
    }
    const wallet = wallets.find((row) => row.id === userId)!;
    if (wallet.aiBalanceCents < 0) return failure(409, WALLET_DEBT_ERROR);
    const debit = BigInt(amount);
    if (wallet.walletBalanceCents < debit) return failure(409, 'На кошельке OpenWritter недостаточно BYN.');
    const expiresAt = nextSubscriptionMonth(remaining ?? now);
    const stillActive = current && (!current.expiresAt || remaining);
    const kind = !stillActive ? 'joined' : current.levelId === levelId ? 'renewed' : level.priceRub > current.level.priceRub ? 'upgraded' : 'joined';
    await tx.user.update({ where: { id: userId }, data: { walletBalanceCents: { decrement: debit } }, select: { id: true } });
    await tx.user.update({ where: { id: authorId }, data: { walletBalanceCents: { increment: debit } }, select: { id: true } });
    await tx.authorSubscription.upsert({
      where, create: { authorId, userId, levelId, expiresAt },
      update: { levelId, expiresAt, cancelledAt: null, ...(!stillActive && { createdAt: now }) },
    });
    const event = await tx.blogAudienceEvent.create({ data: {
      authorId, userId, kind, levelId, levelTitle: level.title, priceRub: level.priceRub, amountCents: amount,
      requestId: payment.requestId, expiresAt,
    } });
    return { status: 200, paymentId: event.id, expiresAt };
  });
}
