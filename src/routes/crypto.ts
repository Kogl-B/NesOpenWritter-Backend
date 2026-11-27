import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { env } from '../lib/env.js';
import { captureError } from '../lib/sentry.js';
import { CURRENCIES, nowPaymentsQuote, type CurrencyQuote } from '../lib/paymentCurrency.js';
import {
  DEPOSIT_TIERS_USD,
  MAX_DEPOSIT_USD,
  MIN_DEPOSIT_USD,
  buildInvoicePayload,
  creditedCents,
  cryptoPaymentsEnabled,
  nowpaymentsApiBase,
  nowpaymentsSandbox,
  nowpaymentsSignatureValid,
} from '../lib/nowpayments.js';

const fiatInput = z.object({
  currency: z.enum(CURRENCIES),
  amountCents: z.coerce.number().int().min(1).max(10_000_000),
});
const createSchema = z.union([
  z.object({ amountUsd: z.number().int().min(MIN_DEPOSIT_USD).max(MAX_DEPOSIT_USD) }),
  fiatInput.extend({ quoteId: z.string().min(1).max(180) }),
]);
const validUsdQuote = (quote: CurrencyQuote) => quote.outputCents >= MIN_DEPOSIT_USD * 100 && quote.outputCents <= MAX_DEPOSIT_USD * 100;

function publicBase(): string {
  return (process.env.FRONTEND_URL ?? 'https://openwritter.app').replace(/\/$/, '');
}

function apiBase(): string {
  return new URL(process.env.API_PUBLIC_URL || env.BETTER_AUTH_URL).origin;
}

interface IpnBody {
  order_id?: string;
  payment_status?: string;
  actually_paid?: number | string;
  pay_amount?: number | string;
}

export const cryptoRoutes: FastifyPluginAsync = async (app) => {
  app.get('/api/payments/crypto/status', async (req) => {
    app.requireAuth(req);
    const user = await prisma.user.findUnique({
      where: { id: req.user!.id },
      select: { aiBalanceCents: true },
    });
    return {
      enabled: cryptoPaymentsEnabled() && Boolean(process.env.NOWPAYMENTS_API_KEY),
      provider: 'nowpayments',
      settlementCurrency: 'USD',
      quoteCurrencies: CURRENCIES,
      sandbox: nowpaymentsSandbox(),
      minUsd: MIN_DEPOSIT_USD,
      maxUsd: MAX_DEPOSIT_USD,
      tiers: DEPOSIT_TIERS_USD,
      aiBalanceCents: user?.aiBalanceCents ?? 0,
    };
  });

  app.get('/api/payments/crypto/invoice-quote', async (req, reply) => {
    app.requireAuth(req);
    reply.header('Cache-Control', 'private, no-store');
    const input = fiatInput.parse(req.query);
    const quote = await nowPaymentsQuote(input.currency, input.amountCents);
    if (!quote) return reply.status(503).send({ error: 'Официальный курс для этой валюты сейчас недоступен.' });
    return { quote, withinLimits: validUsdQuote(quote) };
  });

  app.post('/api/payments/crypto/invoices', async (req, reply) => {
    app.requireAuth(req);
    if (!cryptoPaymentsEnabled()) {
      return reply.status(503).send({ error: 'Криптооплата пока не включена' });
    }
    const apiKey = process.env.NOWPAYMENTS_API_KEY;
    if (!apiKey) {
      return reply.status(503).send({ error: 'Провайдер оплаты не настроен' });
    }
    const input = createSchema.parse(req.body);
    const quote = 'amountUsd' in input
      ? await nowPaymentsQuote('USD', input.amountUsd * 100)
      : await nowPaymentsQuote(input.currency, input.amountCents);
    if (!quote) return reply.status(503).send({ error: 'Официальный курс для этой валюты сейчас недоступен.' });
    if ('quoteId' in input && input.quoteId !== quote.id) {
      return reply.status(409).send({ error: 'Курс изменился. Проверьте новую сумму счёта.' });
    }
    if (!validUsdQuote(quote)) return reply.status(400).send({ error: `Сумма счёта должна быть от ${MIN_DEPOSIT_USD} до ${MAX_DEPOSIT_USD} USD.` });
    const amountUsd = quote.outputCents / 100;
    const payment = await prisma.cryptoPayment.create({
      data: {
        userId: req.user!.id,
        amountUsdCents: quote.outputCents,
        priceQuote: quote,
        purpose: 'ai_balance',
      },
    });
    const payload = buildInvoicePayload({
      amountUsd,
      orderId: payment.id,
      description: `Пополнение баланса OpenWritter, ${amountUsd} USD`,
      ipnUrl: `${apiBase()}/api/payments/nowpayments/webhook`,
      successUrl: `${publicBase()}/account?section=wallet&crypto=ok`,
      cancelUrl: `${publicBase()}/account?section=wallet`,
    });
    const resp = await fetch(`${nowpaymentsApiBase()}/invoice`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
      },
      body: JSON.stringify(payload),
    });
    if (!resp.ok) {
      await prisma.cryptoPayment.update({
        where: { id: payment.id },
        data: { status: 'failed' },
      });
      return reply.status(502).send({ error: 'Провайдер оплаты не ответил' });
    }
    const inv = (await resp.json()) as { id?: string | number; invoice_url?: string };
    const updated = await prisma.cryptoPayment.update({
      where: { id: payment.id },
      data: {
        providerId: inv.id != null ? String(inv.id) : null,
        invoiceUrl: inv.invoice_url ?? null,
      },
    });
    return reply.status(201).send({
      paymentUrl: updated.invoiceUrl,
      orderId: updated.id,
      amountUsd,
      currency: 'USD',
      quote,
    });
  });

  app.post('/api/payments/nowpayments/webhook', async (req, reply) => {
    const secret = process.env.NOWPAYMENTS_IPN_SECRET;
    if (!secret) return reply.status(503).send({ error: 'IPN не настроен' });
    const signature = req.headers['x-nowpayments-sig'];
    const sig = (Array.isArray(signature) ? signature[0] : signature) ?? '';
    if (!nowpaymentsSignatureValid(req.body, sig, secret)) {
      return reply.status(403).send({ error: 'Неверная подпись' });
    }
    const body = req.body as IpnBody;
    if (!body.order_id || !body.payment_status) return { ok: true };
    const debt = await applyNowpaymentsNotice(body);
    if (debt) {
      const context = { code: 'WALLET_REFUND_DEBT', orderId: body.order_id, ...debt };
      req.log.fatal(context, 'Refund exceeds available USD wallet balance');
      captureError(new Error('WALLET_REFUND_DEBT'), context);
    }
    return { ok: true };
  });
};

export async function applyNowpaymentsNotice(body: IpnBody) {
  const { payment_status: status, order_id: orderId } = body;
  if (!orderId || !status) return;

  return prisma.$transaction(async (tx) => {
    const [payment] = await tx.$queryRaw<Array<{
      id: string; userId: string; amountUsdCents: number; creditedUsdCents: number;
      creditedAt: Date | null; reversedAt: Date | null; status: string;
    }>>`
      SELECT id, "userId", "amountUsdCents", "creditedUsdCents", "creditedAt", "reversedAt", status
      FROM crypto_payments WHERE id = ${orderId} AND provider = 'nowpayments' FOR UPDATE
    `;
    if (!payment || payment.reversedAt) return;
    const where = { id: payment.id };

    if (status === 'refunded') {
      await tx.cryptoPayment.update({ where, data: { status: 'refunded', reversedAt: new Date() } });
      if (!payment.creditedUsdCents) return;
      const wallet = await tx.user.update({
        where: { id: payment.userId },
        data: { aiBalanceCents: { decrement: payment.creditedUsdCents } },
        select: { aiBalanceCents: true },
      });
      if (wallet.aiBalanceCents < 0) {
        const debtCents = -wallet.aiBalanceCents;
        const operators = await tx.user.findMany({ where: { accountStatus: 'admin' }, select: { id: true } });
        await tx.notification.createMany({
          data: operators.map(({ id }) => ({
            userId: id, kind: 'admin_message', title: 'Платёж возвращён после расходования средств',
            body: `Счёт ${orderId}. Задолженность ${(debtCents / 100).toFixed(2)} USD.`,
            href: '/admin1', eventKey: `finance-refund-debt:${orderId}`,
          })),
          skipDuplicates: true,
        });
        return { userId: payment.userId, reversedCents: payment.creditedUsdCents, debtCents };
      }
      return;
    }

    if (payment.status === 'finished') return;
    const cents = creditedCents(payment.amountUsdCents, status, body.actually_paid, body.pay_amount);
    if (cents != null) {
      const delta = cents - payment.creditedUsdCents;
      if (delta <= 0 && status !== 'finished') return;
      await tx.cryptoPayment.update({
        where, data: {
          status: status === 'finished' ? 'finished' : 'partial',
          creditedAt: payment.creditedAt ?? new Date(),
          creditedUsdCents: Math.max(cents, payment.creditedUsdCents),
        },
      });
      if (delta > 0) {
        await tx.user.update({
          where: { id: payment.userId }, data: { aiBalanceCents: { increment: delta } },
        });
      }
      return;
    }

    if ((status === 'failed' || status === 'expired') && !payment.creditedAt) {
      await tx.cryptoPayment.update({ where, data: { status: 'canceled' } });
    }
  });
}
