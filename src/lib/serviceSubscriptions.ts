import type { prisma } from './prisma.js';
import { DEFAULT_TIER, getTier, type TierId } from './tiers.js';
import { nextSubscriptionMonth } from './subscriptionPeriod.js';
import { lockWallets, WALLET_DEBT_ERROR } from './wallet.js';

type PlanReader = Pick<typeof prisma, 'user' | 'walletOperation'>;

export async function serviceAccess(db: PlanReader, userId: string, now = new Date()) {
  const user = await db.user.findUnique({ where: { id: userId }, select: { plan: true } });
  const tier = getTier(user?.plan);
  if (!tier.priceByn) return { plan: DEFAULT_TIER, expiresAt: null };

  const receipt = await db.walletOperation.findFirst({
    where: { userId, plan: tier.id, kind: 'service-plan', expiresAt: { gt: now } },
    orderBy: { expiresAt: 'desc' },
    select: { expiresAt: true },
  });
  return receipt?.expiresAt
    ? { plan: tier.id, expiresAt: receipt.expiresAt }
    : { plan: DEFAULT_TIER, expiresAt: null };
}

type Confirmation = { requestId: string; amountCents: number };
type PlanWriter = Pick<typeof prisma, '$transaction'>;
type PlanResult = { status: number; error: string } | { paymentId: string | null };

export async function changeServicePlan(db: PlanWriter, userId: string, plan: TierId, payment?: Confirmation): Promise<PlanResult> {
  const tier = getTier(plan);
  if (tier.priceByn == null) return { status: 400, error: 'Этот тариф подключается по договорённости.' };
  const amountCents = Math.round(tier.priceByn * 100);
  if (amountCents && !payment) return { status: 402, error: 'Подтвердите оплату месяца с кошелька OpenWritter.' };
  if ((!amountCents && payment) || (payment && payment.amountCents !== amountCents)) {
    return { status: 409, error: 'Цена тарифа изменилась. Проверьте сумму и подтвердите оплату снова.' };
  }

  return db.$transaction<PlanResult>(async tx => {
    const [wallet] = await lockWallets(tx, [userId]);
    if (!wallet) return { status: 404, error: 'Кошелёк не найден.' };
    if (payment) {
      const previous = await tx.walletOperation.findUnique({
        where: { userId_requestId: { userId, requestId: payment.requestId } },
      });
      if (previous) {
        if (previous.kind !== 'service-plan' || previous.plan !== plan || previous.sourceCents !== amountCents) {
          return { status: 409, error: 'Этот идентификатор уже связан с другой операцией.' };
        }
        return { paymentId: previous.requestId };
      }
    }
    const now = new Date();
    const current = await serviceAccess(tx, userId, now);
    if (current.expiresAt) {
      return { status: 409, error: 'Текущий тариф уже оплачен. Сменить тариф можно после окончания оплаченного месяца.' };
    }
    if (payment) {
      if (wallet.aiBalanceCents < 0) return { status: 409, error: WALLET_DEBT_ERROR };
      if (wallet.walletBalanceCents < BigInt(amountCents)) {
        return { status: 402, error: 'На основном кошельке недостаточно BYN.' };
      }
      await tx.user.update({ where: { id: userId }, data: {
        plan, walletBalanceCents: { decrement: BigInt(amountCents) },
      } });
      await tx.walletOperation.create({ data: {
        userId, requestId: payment.requestId, kind: 'service-plan', sourceCents: amountCents,
        receivedCents: 0, plan, expiresAt: nextSubscriptionMonth(now),
      } });
      return { paymentId: payment.requestId };
    }
    await tx.user.update({ where: { id: userId }, data: { plan } });
    return { paymentId: null };
  });
}
