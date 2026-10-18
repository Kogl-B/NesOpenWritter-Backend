import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import {
  NOWPAYMENTS_API,
  buildInvoicePayload,
  cryptoPaymentsEnabled,
  nowpaymentsSignatureValid,
} from '../lib/nowpayments.js';

const createSchema = z.object({
  amountUsd: z.number().int().min(1).max(500),
});

function publicBase(): string {
  return (process.env.FRONTEND_URL ?? 'https://openwritter.app').replace(/\/$/, '');
}

function apiBase(reqHost: string): string {
  const fromEnv = process.env.API_PUBLIC_URL?.replace(/\/$/, '');
  if (fromEnv) return fromEnv;
  return reqHost.replace(/\/$/, '');
}

export const cryptoRoutes: FastifyPluginAsync = async (app) => {
  app.get('/api/payments/crypto/status', async (req) => {
    app.requireAuth(req);
    const user = await prisma.user.findUnique({
      where: { id: req.user!.id },
      select: { aiBalanceCents: true },
    });
    return {
      enabled: cryptoPaymentsEnabled(),
      provider: 'nowpayments',
      aiBalanceCents: user?.aiBalanceCents ?? 0,
    };
  });

  app.post('/api/payments/crypto/invoices', async (req, reply) => {
    app.requireAuth(req);
    if (!cryptoPaymentsEnabled()) {
      return reply.status(503).send({ error: 'Криптооплата пока не включена' });
    }
    if (!process.env.NOWPAYMENTS_API_KEY) {
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
      description: `Баланс ИИ OpenWritter, ${input.amountUsd} USD`,
      ipnUrl: `${apiBase(origin)}/api/payments/nowpayments/webhook`,
      successUrl: `${publicBase()}/account?crypto=ok`,
      cancelUrl: `${publicBase()}/account`,
    });
    const resp = await fetch(`${NOWPAYMENTS_API}/invoice`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.NOWPAYMENTS_API_KEY,
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
    const body = req.body as {
      order_id?: string;
      payment_status?: string;
      actually_paid?: number | string;
      pay_amount?: number | string;
    };
    if (!body.order_id) return { ok: true };
    const payment = await prisma.cryptoPayment.findFirst({
      where: { id: body.order_id, provider: 'nowpayments' },
    });
    if (!payment || payment.creditedAt) return { ok: true };

    if (body.payment_status === 'finished') {
      await prisma.$transaction([
        prisma.user.update({
          where: { id: payment.userId },
          data: { aiBalanceCents: { increment: payment.amountUsdCents } },
        }),
        prisma.cryptoPayment.update({
          where: { id: payment.id },
          data: { status: 'finished', creditedAt: new Date() },
        }),
      ]);
      return { ok: true };
    }

    if (body.payment_status === 'failed' || body.payment_status === 'expired') {
      await prisma.cryptoPayment.update({
        where: { id: payment.id },
        data: { status: 'canceled' },
      });
    }
    return { ok: true };
  });
};
