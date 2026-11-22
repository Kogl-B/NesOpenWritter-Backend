import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import { prisma } from '../lib/prisma.js';
import { toJson } from '../lib/access.js';
import { resolveAccountStatus } from '../lib/accountStatus.js';
import { userSettingsUpdateSchema } from '../lib/schemas.js';
import { bynPerUnit, getRates } from '../lib/currency.js';

const profileSchema = z.object({
  name: z.string().trim().min(1).max(80),
});

function avatarOk(value: unknown): boolean {
  return value == null || (typeof value === 'string' && (value === '' || (value.startsWith('data:image/') && value.length <= 220_000)));
}

export const meRoutes: FastifyPluginAsync = async (app) => {
  app.get('/api/me', async (req, reply) => {
    app.requireAuth(req);
    const settings = await prisma.user.findUnique({
      where: { id: req.user!.id },
      select: { settings: true, plan: true },
    });
    const accountStatus = await resolveAccountStatus(req.user!.id, req.user!.email);
    return reply.send({
      user: { ...req.user, plan: settings?.plan ?? 'test', accountStatus },
      settings: settings?.settings ?? {},
    });
  });

  app.patch('/api/me/profile', async (req) => {
    app.requireAuth(req);
    const input = profileSchema.parse(req.body);
    const user = await prisma.user.update({
      where: { id: req.user!.id },
      data: { name: input.name },
      select: { id: true, name: true, email: true },
    });
    return { user };
  });

  app.patch('/api/me/settings', async (req, reply) => {
    app.requireAuth(req);
    const input = userSettingsUpdateSchema.parse(req.body);
    if ('avatar' in input.settings && !avatarOk(input.settings.avatar)) {
      return reply.status(400).send({ error: 'Аватар: изображение JPEG до 150 КБ' });
    }
    const current = await prisma.user.findUnique({
      where: { id: req.user!.id },
      select: { settings: true },
    });
    const prev = current?.settings && typeof current.settings === 'object' && !Array.isArray(current.settings)
      ? current.settings as Record<string, unknown>
      : {};
    const updated = await prisma.user.update({
      where: { id: req.user!.id },
      data: { settings: toJson(mergeSettings(prev, input.settings)) },
      select: { settings: true },
    });
    return { settings: updated.settings };
  });

  app.post('/api/me/wallet/transfer', async (req, reply) => {
    app.requireAuth(req);
    const input = transferSchema.parse(req.body);
    const rates = await getRates();
    const bynPerUsd = bynPerUnit(rates.USD);
    if (!Number.isFinite(bynPerUsd) || bynPerUsd <= 0) {
      return reply.status(503).send({ error: 'Курс НБ РБ сейчас недоступен, перевод не выполнен' });
    }
    const current = await prisma.user.findUnique({
      where: { id: req.user!.id },
      select: { settings: true, aiBalanceCents: true },
    });
    const prev = current?.settings && typeof current.settings === 'object' && !Array.isArray(current.settings)
      ? current.settings as Record<string, unknown>
      : {};
    const wallet = walletOf(prev.wallet);
    const aiCents = current?.aiBalanceCents ?? 0;
    const moved = moveMoney(input.direction, input.amount, wallet.balanceCents, aiCents, bynPerUsd);
    if ('error' in moved) return reply.status(400).send({ error: moved.error });
    const updated = await prisma.user.update({
      where: { id: req.user!.id },
      data: {
        aiBalanceCents: moved.aiCents,
        settings: toJson({
          ...prev,
          wallet: { ...wallet.raw, balance: moved.balanceByn, ops: wallet.ops },
        }),
      },
      select: { settings: true, aiBalanceCents: true },
    });
    return {
      settings: updated.settings,
      aiBalanceCents: updated.aiBalanceCents,
      balanceByn: moved.balanceByn,
      rateBynPerUsd: Math.round(bynPerUsd * 10000) / 10000,
    };
  });
};

const transferSchema = z.object({
  direction: z.enum(['to-ai', 'to-wallet']),
  amount: z.number().positive().max(100_000),
});

function mergeSettings(prev: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const next = { ...prev, ...patch };
  if (!patch.wallet || typeof patch.wallet !== 'object' || Array.isArray(patch.wallet)) return next;
  const prevWallet = walletOf(prev.wallet);
  const incoming = patch.wallet as Record<string, unknown>;
  const { balance: _clientBalance, ...rest } = incoming;
  next.wallet = { ...prevWallet.raw, ...rest, balance: prevWallet.balanceByn, ops: rest.ops ?? prevWallet.ops };
  return next;
}

function walletOf(value: unknown): { raw: Record<string, unknown>; balanceByn: number; balanceCents: number; ops: unknown } {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? { ...(value as Record<string, unknown>) } : {};
  const balance = typeof raw.balance === 'number' && Number.isFinite(raw.balance) ? Math.max(0, raw.balance) : 0;
  const balanceCents = Math.round(balance * 100);
  const balanceByn = balanceCents / 100;
  return { raw, balanceByn, balanceCents, ops: raw.ops ?? [] };
}

function moveMoney(
  direction: 'to-ai' | 'to-wallet',
  amount: number,
  balanceCents: number,
  aiCents: number,
  bynPerUsd: number,
): { balanceByn: number; aiCents: number } | { error: string } {
  if (direction === 'to-ai') {
    const take = Math.round(amount * 100);
    if (take < 1) return { error: 'Сумма слишком мала' };
    if (take > balanceCents) return { error: 'На основном кошельке недостаточно BYN' };
    const usdCents = Math.round((take / 100 / bynPerUsd) * 100);
    if (usdCents < 1) return { error: 'После курса сумма меньше одного цента' };
    return { balanceByn: (balanceCents - take) / 100, aiCents: aiCents + usdCents };
  }
  const usdCents = Math.round(amount * 100);
  if (usdCents < 1) return { error: 'Сумма слишком мала' };
  if (usdCents > aiCents) return { error: 'На счёте ИИ недостаточно долларов' };
  const addByn = Math.round((usdCents / 100) * bynPerUsd * 100);
  return { balanceByn: (balanceCents + addByn) / 100, aiCents: aiCents - usdCents };
}
