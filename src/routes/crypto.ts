import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
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

const createSchema = z.object({
  amountUsd: z.number().int().min(MIN_DEPOSIT_USD).max(MAX_DEPOSIT_USD),
});

function publicBase(): string {
  return (process.env.FRONTEND_URL ?? 'https://openwritter.app').replace(/\/$/, '');
}

function apiBase(reqHost: string): string {
  const fromEnv = process.env.API_PUBLIC_URL?.replace(/\/$/, '');
  if (fromEnv) return fromEnv;
  return reqHost.replace(/\/$/, '');
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
      sandbox: nowpaymentsSandbox(),
      minUsd: MIN_DEPOSIT_USD,
      maxUsd: MAX_DEPOSIT_USD,
      tiers: DEPOSIT_TIERS_USD,
      aiBalanceCents: user?.aiBalanceCents ?? 0,
    };
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
    const payment = await prisma.cryptoPayment.create({
      data: {
        userId: req.user!.id,
        amountUsdCents: input.amountUsd * 100,
        purpose: 'ai_balance',
      },
    });
    const origin = `${req.protocol}://${req.hostname}`;
    const payload = buildInvoicePayload({
      amountUsd: input.amountUsd,
      orderId: payment.id,
      description: `Пополнение баланса OpenWritter, ${input.amountUsd} USD`,
      ipnUrl: `${apiBase(origin)}/api/payments/nowpayments/webhook`,
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
      amountUsd: input.amountUsd,
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
    await applyNowpaymentsNotice(body);
    return { ok: true };
  });
};

export async function applyNowpaymentsNotice(body: IpnBody): Promise<void> {
  const status = body.payment_status;
  if (!body.order_id || !status) return;
  const payment = await prisma.cryptoPayment.findFirst({
    where: { id: body.order_id, provider: 'nowpayments' },
  });
  if (!payment) return;

  const cents = creditedCents(payment.amountUsdCents, status, body.actually_paid, body.pay_amount);
  if (cents != null) {
    await prisma.$transaction(async (tx) => {
      const marked = await tx.cryptoPayment.updateMany({
        where: { id: payment.id, creditedAt: null, reversedAt: null },
        data: {
          status: status === 'partially_paid' ? 'partial' : 'finished',
          creditedAt: new Date(),
          creditedUsdCents: cents,
        },
      });
      if (marked.count !== 1 || cents <= 0) return;
      await tx.user.update({
        where: { id: payment.userId },
        data: { aiBalanceCents: { increment: cents } },
      });
    });
    return;
  }

  if (status === 'refunded') {
    await prisma.$transaction(async (tx) => {
      const row = await tx.cryptoPayment.findUnique({ where: { id: payment.id } });
      if (!row || row.reversedAt) return;
      const marked = await tx.cryptoPayment.updateMany({
        where: { id: row.id, reversedAt: null },
        data: { status: 'refunded', reversedAt: new Date() },
      });
      if (marked.count !== 1) return;
      if (row.creditedAt && row.creditedUsdCents > 0) {
        await tx.user.update({
          where: { id: row.userId },
          data: { aiBalanceCents: { decrement: row.creditedUsdCents } },
        });
      }
    });
    return;
  }

  if ((status === 'failed' || status === 'expired') && !payment.creditedAt && !payment.reversedAt) {
    await prisma.cryptoPayment.updateMany({
      where: { id: payment.id, creditedAt: null, reversedAt: null },
      data: { status: 'canceled' },
    });
  }
}
