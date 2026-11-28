import type { FastifyPluginAsync } from 'fastify';
import { Prisma } from '@prisma/client';
import { z } from 'zod';

import { collectAccountPhotos, pagePhotos, PHOTO_PAGE } from '../lib/accountPhotos.js';
import {
  accessForPage,
  emptyAccess,
  PHOTO_VISIBILITY,
  photoByToken,
  photosSharedWith,
  savePhotoAccess,
} from '../lib/photoAccess.js';
import { prisma } from '../lib/prisma.js';
import { isR2Configured, isPersonalPhotoKey, objectSizeBytes, presignPersonalUpload, publicObjectUrl } from '../lib/r2.js';
import { rememberStoredFile } from '../lib/storedFileSync.js';
import { getUserPlan, getStorageUsedBytes } from './account.js';
import { getTier, MB } from '../lib/tiers.js';
import { toJson } from '../lib/access.js';
import { resolveAccountStatus } from '../lib/accountStatus.js';
import { userSettingsUpdateSchema } from '../lib/schemas.js';
import { lockWallets, settingsRecord, settingsWithWallet } from '../lib/wallet.js';
import { EXCHANGE_RATE_SCALE } from '../lib/walletExchange.js';
import { CURRENCIES, walletQuote, type Currency, type CurrencyQuote } from '../lib/paymentCurrency.js';

const homeBlocks = z.array(z.string().regex(/^[a-zA-Z][a-zA-Z0-9-]{0,31}$/)).max(25);
const homeLayout = z.object({ left: homeBlocks, main: homeBlocks, right: homeBlocks, hidden: homeBlocks })
  .strict()
  .refine((layout) => {
    const ids = Object.values(layout).flat();
    return ids.length <= 25 && new Set(ids).size === ids.length;
  }, 'Блок может быть только в одном месте');

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
      select: { settings: true, walletBalanceCents: true },
    });
    const [accountStatus, plan] = await Promise.all([
      resolveAccountStatus(req.user!.id, req.user!.email),
      getUserPlan(req.user!.id),
    ]);
    return reply.send({
      user: { ...req.user, plan, accountStatus },
      settings: settingsWithWallet(settings?.settings, settings?.walletBalanceCents ?? 0n),
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
    if ('homeLayout' in input.settings) homeLayout.parse(input.settings.homeLayout);
    const userId = req.user!.id;
    const updated = await prisma.$transaction(async (tx) => {
      const [current] = await tx.$queryRaw<Array<{ settings: unknown }>>`
        SELECT settings FROM users WHERE id = ${userId} FOR UPDATE
      `;
      return tx.user.update({
        where: { id: userId },
        data: { settings: toJson(mergeSettings(settingsRecord(current?.settings), input.settings)) },
        select: { settings: true, walletBalanceCents: true },
      });
    });
    return { settings: settingsWithWallet(updated.settings, updated.walletBalanceCents) };
  });

  app.get('/api/me/photos', async (req) => {
    app.requireAuth(req);
    const query = z.object({
      page: z.coerce.number().int().min(1).optional(),
      limit: z.coerce.number().int().min(1).max(PHOTO_PAGE).optional(),
      q: z.string().trim().max(160).optional(),
    }).parse(req.query);
    const photos = await collectAccountPhotos(req.user!.id);
    const search = query.q?.toLocaleLowerCase('ru-RU');
    const matches = search ? photos.filter(({ title, projectName, placeLabel }) =>
      [title, projectName, placeLabel].some((value) => value.toLocaleLowerCase('ru-RU').includes(search)),
    ) : photos;
    const page = pagePhotos(matches, query.page ?? 1, query.limit ?? PHOTO_PAGE);
    const access = await accessForPage(req.user!.id, page.photos.map((photo) => photo.href));
    return {
      ...page,
      photos: page.photos.map((photo) => ({
        ...photo,
        access: access.get(photo.href) ?? emptyAccess(),
      })),
    };
  });

  app.get('/api/me/photos/shared', async (req) => {
    app.requireAuth(req);
    const query = z.object({
      page: z.coerce.number().int().min(1).optional(),
      limit: z.coerce.number().int().min(1).max(PHOTO_PAGE).optional(),
    }).parse(req.query);
    const photos = await photosSharedWith(req.user!.id);
    const page = query.page ?? 1;
    const pageSize = query.limit ?? PHOTO_PAGE;
    const start = (page - 1) * pageSize;
    return { total: photos.length, page, pageSize, photos: photos.slice(start, start + pageSize) };
  });

  app.patch('/api/me/photos/access', async (req) => {
    app.requireAuth(req);
    const input = z.object({
      href: z.string().trim().min(10).max(250_000),
      title: z.string().trim().max(160).optional(),
      visibility: z.enum(PHOTO_VISIBILITY),
      accounts: z.array(z.string().trim().min(1).max(120)).max(30).optional(),
    }).parse(req.body);
    return savePhotoAccess({
      userId: req.user!.id,
      href: input.href,
      title: input.title ?? '',
      visibility: input.visibility,
      accounts: input.accounts ?? [],
    });
  });

  app.post('/api/me/photos/presign', async (req, reply) => {
    app.requireAuth(req);
    if (!isR2Configured()) return reply.status(503).send({ error: 'Хранилище картинок не настроено' });
    const input = z.object({
      filename: z.string().trim().min(1).max(255),
      contentType: z.enum(['image/jpeg', 'image/png', 'image/webp', 'image/gif']),
      sizeBytes: z.number().int().positive().max(20 * 1024 * 1024),
    }).parse(req.body);
    const tier = getTier(await getUserPlan(req.user!.id));
    if (tier.storageLimitMb != null) {
      const used = await getStorageUsedBytes(req.user!.id);
      if (used + input.sizeBytes > tier.storageLimitMb * MB) {
        return reply.status(403).send({
          error: `Недостаточно места тарифа «${tier.name}»: занято ${(used / MB).toFixed(1)} МБ из ${tier.storageLimitMb} МБ.`,
        });
      }
    }
    return presignPersonalUpload({
      userId: req.user!.id,
      filename: input.filename,
      contentType: input.contentType,
    });
  });

  app.post('/api/me/photos/complete', async (req, reply) => {
    app.requireAuth(req);
    const input = z.object({ key: z.string().trim().min(1).max(500) }).parse(req.body);
    if (!isPersonalPhotoKey(req.user!.id, input.key)) {
      return reply.status(400).send({ error: 'Файл не из хранилища этого кабинета' });
    }
    const sizeBytes = await objectSizeBytes(input.key);
    if (sizeBytes == null) return reply.status(404).send({ error: 'Файл в хранилище не найден' });
    const tier = getTier(await getUserPlan(req.user!.id));
    if (tier.storageLimitMb != null) {
      const used = await getStorageUsedBytes(req.user!.id);
      if (used + sizeBytes > tier.storageLimitMb * MB) {
        return reply.status(403).send({ error: `Недостаточно места тарифа «${tier.name}».` });
      }
    }
    const href = publicObjectUrl(input.key);
    if (!href) return reply.status(503).send({ error: 'Хранилище не вернуло адрес картинки' });
    await rememberStoredFile({
      userId: req.user!.id,
      projectId: null,
      key: input.key,
      sizeBytes,
      kind: 'other',
    });
    return { href, key: input.key, sizeBytes };
  });

  app.get<{ Params: { token: string } }>('/api/photos/:token', async (req, reply) => {
    const token = z.string().trim().min(8).max(40).parse(req.params.token);
    const photo = await photoByToken(token, req.user?.id ?? null);
    if (!photo) return reply.status(404).send({ error: 'Фото не найдено или закрыто' });
    return photo;
  });

  app.get('/api/me/blacklist', async (req) => {
    app.requireAuth(req);
    const input = blacklistQuery.parse(req.query);
    const q = input.q?.trim() ?? '';
    const page = input.page;
    const skip = (page - 1) * BLACKLIST_PAGE;
    const found = input.kind === 'books'
      ? await bookPage(q, skip)
      : input.kind === 'blogs'
        ? await blogPage(q, skip)
        : await peoplePage(req.user!.id, q, skip);
    return { kind: input.kind, page, pageSize: BLACKLIST_PAGE, total: found.total, items: found.items };
  });

  app.get('/api/me/wallet/balances', async (req) => {
    app.requireAuth(req);
    const wallet = await prisma.user.findUniqueOrThrow({ where: { id: req.user!.id }, select: walletSelect });
    return { balances: currencyBalances(wallet) };
  });

  app.get('/api/me/wallet/quote', async (req, reply) => {
    app.requireAuth(req);
    reply.header('Cache-Control', 'private, no-store');
    const { from, to, amountCents } = quoteSchema.parse(req.query);
    if (from === to) return reply.status(400).send({ error: 'Выберите разные валюты.' });
    const quote = await walletQuote(from, to, amountCents);
    if (!quote) return reply.status(503).send({ error: 'Курс НБ РБ сейчас недоступен.' });
    if (!quote.outputCents) return reply.status(400).send({ error: 'После обмена сумма меньше минимальной денежной единицы.' });
    return { quote };
  });

  app.post('/api/me/wallet/transfer', async (req, reply) => {
    app.requireAuth(req);
    const input = transferSchema.parse(req.body);
    const legacy = 'direction' in input;
    const from = legacy ? input.direction === 'to-ai' ? 'BYN' : 'USD' : input.from;
    const to = legacy ? input.direction === 'to-ai' ? 'USD' : 'BYN' : input.to;
    const sourceCents = legacy ? Math.round(input.amount * 100) : input.amountCents;
    if (from === to) return reply.status(400).send({ error: 'Выберите разные валюты.' });
    const id = req.user!.id;
    const where = { userId_requestId: { userId: id, requestId: input.requestId } };
    const known = await prisma.walletOperation.findUnique({ where, select: { requestId: true } });
    const quote = known ? null : await walletQuote(from, to, sourceCents);
    const result = await prisma.$transaction(async (tx) => {
      await lockWallets(tx, [id]);
      const current = await tx.user.findUniqueOrThrow({ where: { id }, select: walletSelect });
      const previous = await tx.walletOperation.findUnique({ where });
      if (previous) {
        const samePair = previous.fromCurrency === from && previous.toCurrency === to;
        const legacyPair = previous.rateUnits != null && previous.kind === (from === 'USD' && to === 'BYN'
          ? 'to-wallet' : from === 'BYN' && to === 'USD' ? 'to-ai' : null);
        const savedQuote = savedExchangeQuote(previous.exchangeQuote);
        if ((!samePair && !legacyPair) || previous.sourceCents !== sourceCents) {
          return { status: 409, error: 'Этот идентификатор уже связан с другой операцией.' };
        }
        return transferReceipt(current, previous, savedQuote);
      }
      if (!quote) return { status: 503, error: 'Курс НБ РБ сейчас недоступен, обмен не выполнен.' };
      if (!legacy && quote.id !== input.quoteId) {
        return { status: 409, error: 'Курс изменился. Проверьте новую сумму и подтвердите обмен.' };
      }
      if (!quote.outputCents) return { status: 400, error: 'После обмена сумма меньше минимальной денежной единицы.' };
      const balances = currencyBalances(current);
      if (sourceCents > balances[from]) return { status: 400, error: `На кошельке недостаточно ${from}.` };
      if (to === 'USD' && balances.USD + quote.outputCents > 2_147_483_647) {
        return { status: 400, error: 'Сумма превышает предел долларового кошелька.' };
      }
      const updated = await tx.user.update({
        where: { id },
        data: { ...walletIncrement(from, -sourceCents), ...walletIncrement(to, quote.outputCents) },
        select: walletSelect,
      });
      const receipt = await tx.walletOperation.create({ data: {
        userId: id, requestId: input.requestId, kind: 'exchange', sourceCents, receivedCents: quote.outputCents,
        fromCurrency: from, toCurrency: to, exchangeQuote: quote,
      } });
      return transferReceipt(updated, receipt, quote);
    });
    if ('error' in result) return reply.status(result.status).send({ error: result.error });
    return result;
  });
};

const BLACKLIST_PAGE = 20;

const blacklistQuery = z.object({
  kind: z.enum(['people', 'books', 'blogs']).default('people'),
  q: z.string().max(80).optional(),
  page: z.coerce.number().int().min(1).max(500).default(1),
});

function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

function filterSql(q: string, columns: Prisma.Sql): Prisma.Sql {
  if (!q) return Prisma.sql`TRUE`;
  return Prisma.sql`${columns} ILIKE ${likePattern(q)} ESCAPE '\\'`;
}

async function peoplePage(meId: string, q: string, skip: number) {
  const where = Prisma.sql`u.id <> ${meId} AND ${filterSql(q, Prisma.sql`COALESCE(u.name, '')`)}`;
  const total = await prisma.$queryRaw<Array<{ total: number }>>`
    SELECT COUNT(*)::int AS total FROM users u WHERE ${where}
  `;
  const rows = await prisma.$queryRaw<Array<{ id: string; title: string; author: boolean; marked: boolean }>>`
    SELECT u.id,
           COALESCE(NULLIF(TRIM(u.name), ''), 'Без имени') AS title,
           COALESCE(u.settings->>'author', '') = 'true' AS marked,
           EXISTS (
             SELECT 1 FROM projects p
             WHERE p."ownerId" = u.id
               AND COALESCE(p.settings #>> '{catalog,published}', '') = 'true'
           ) AS author
    FROM users u
    WHERE ${where}
    ORDER BY title, u.id
    LIMIT ${BLACKLIST_PAGE} OFFSET ${skip}
  `;
  return {
    total: Number(total[0]?.total ?? 0),
    items: rows.map((row) => ({
      id: row.id,
      title: row.title,
      note: row.author || row.marked ? 'автор' : 'читатель',
    })),
  };
}

async function bookPage(q: string, skip: number) {
  const where = Prisma.sql`
    COALESCE(p.settings #>> '{catalog,published}', '') = 'true'
    AND ${filterSql(q, Prisma.sql`p.name || ' ' || COALESCE(u.name, '')`)}
  `;
  const total = await prisma.$queryRaw<Array<{ total: number }>>`
    SELECT COUNT(*)::int AS total
    FROM projects p JOIN users u ON u.id = p."ownerId"
    WHERE ${where}
  `;
  const rows = await prisma.$queryRaw<Array<{ id: string; title: string; author: string }>>`
    SELECT p.id, p.name AS title, COALESCE(NULLIF(TRIM(u.name), ''), 'Автор') AS author
    FROM projects p JOIN users u ON u.id = p."ownerId"
    WHERE ${where}
    ORDER BY p.name, p.id
    LIMIT ${BLACKLIST_PAGE} OFFSET ${skip}
  `;
  return {
    total: Number(total[0]?.total ?? 0),
    items: rows.map((row) => ({ id: row.id, title: row.title, note: row.author })),
  };
}

async function blogPage(q: string, skip: number) {
  const where = Prisma.sql`
    b.published = true
    AND ${filterSql(q, Prisma.sql`b.title || ' ' || COALESCE(u.name, '')`)}
  `;
  const total = await prisma.$queryRaw<Array<{ total: number }>>`
    SELECT COUNT(*)::int AS total
    FROM blog_posts b JOIN users u ON u.id = b."authorId"
    WHERE ${where}
  `;
  const rows = await prisma.$queryRaw<Array<{ id: string; title: string; author: string }>>`
    SELECT b.id, b.title, COALESCE(NULLIF(TRIM(u.name), ''), 'Автор') AS author
    FROM blog_posts b JOIN users u ON u.id = b."authorId"
    WHERE ${where}
    ORDER BY b.title, b.id
    LIMIT ${BLACKLIST_PAGE} OFFSET ${skip}
  `;
  return {
    total: Number(total[0]?.total ?? 0),
    items: rows.map((row) => ({ id: row.id, title: row.title, note: row.author })),
  };
}

const quoteSchema = z.object({
  from: z.enum(CURRENCIES),
  to: z.enum(CURRENCIES),
  amountCents: z.coerce.number().int().min(1).max(10_000_000),
});
const transferSchema = z.union([
  quoteSchema.extend({ requestId: z.string().uuid(), quoteId: z.string().min(1).max(180) }),
  z.object({
    direction: z.enum(['to-ai', 'to-wallet']),
    amount: z.number().min(0.01).max(100_000).refine(amount => Math.abs(amount * 100 - Math.round(amount * 100)) < 0.000001),
    requestId: z.string().uuid(),
  }),
]);

function mergeSettings(prev: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const next = { ...prev, ...patch };
  if (!('wallet' in patch)) return next;
  const { balance: _oldBalance, ...saved } = settingsRecord(prev.wallet);
  const { balance: _clientBalance, ...incoming } = settingsRecord(patch.wallet);
  next.wallet = { ...saved, ...incoming, ops: incoming.ops ?? saved.ops ?? [] };
  return next;
}

const walletSelect = { settings: true, walletBalanceCents: true, aiBalanceCents: true, rubBalanceCents: true } as const;
type Wallet = { settings: unknown; walletBalanceCents: bigint; aiBalanceCents: number; rubBalanceCents: bigint };

function currencyBalances(wallet: Wallet): Record<Currency, number> {
  return { BYN: Number(wallet.walletBalanceCents), USD: wallet.aiBalanceCents, RUB: Number(wallet.rubBalanceCents) };
}

function walletIncrement(currency: Currency, cents: number): Prisma.UserUpdateInput {
  switch (currency) {
    case 'BYN': return { walletBalanceCents: { increment: BigInt(cents) } };
    case 'RUB': return { rubBalanceCents: { increment: BigInt(cents) } };
    case 'USD': return { aiBalanceCents: { increment: cents } };
  }
}

function savedExchangeQuote(value: Prisma.JsonValue): CurrencyQuote | null {
  return value && typeof value === 'object' && !Array.isArray(value) && typeof value.id === 'string'
    ? value as CurrencyQuote : null;
}

function transferReceipt(
  wallet: Wallet,
  receipt: { requestId: string; rateUnits: number | null; sourceCents: number; receivedCents: number },
  quote: CurrencyQuote | null,
) {
  const bynPerUsd = quote?.from === 'USD' && quote.to === 'BYN' ? quote.rate
    : quote?.from === 'BYN' && quote.to === 'USD' ? 1 / quote.rate
    : receipt.rateUnits == null ? null : receipt.rateUnits / EXCHANGE_RATE_SCALE;
  return {
    settings: settingsWithWallet(wallet.settings, wallet.walletBalanceCents),
    balances: currencyBalances(wallet),
    aiBalanceCents: wallet.aiBalanceCents,
    balanceByn: Number(wallet.walletBalanceCents) / 100,
    paymentId: receipt.requestId,
    sourceCents: receipt.sourceCents,
    receivedCents: receipt.receivedCents,
    rateBynPerUsd: bynPerUsd,
    quote,
  };
}
