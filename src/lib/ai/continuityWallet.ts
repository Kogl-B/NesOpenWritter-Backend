import { Prisma } from '@prisma/client';
import { z } from 'zod';

import { prisma } from '../prisma.js';
import { lockWallets, settingsRecord } from '../wallet.js';
import { AiHttpError } from './aiError.js';
import { recordUsage, usageSince } from './meter.js';
import { aiBalanceRefusal } from './openaiImage.js';

const holdSchema = z.object({
  version: z.literal(1),
  cents: z.number().int().min(0).max(2_147_483_647),
  wallet: z.boolean(),
});
type Hold = z.infer<typeof holdSchema>;

export function continuityHold(resultData: unknown): Hold | undefined {
  const result = holdSchema.safeParse(settingsRecord(resultData)._continuityHold);
  return result.success ? result.data : undefined;
}

type SerializedRequest = Record<string, unknown>;
function equivalentRequest(first: unknown, second: SerializedRequest) {
  const saved = settingsRecord(first);
  return ['projectId', 'continuityMode', 'context', 'selection'].every((key) => saved[key] === second[key]);
}

export async function findContinuityRetry(userId: string, input: SerializedRequest, db: Pick<typeof prisma, 'aiJob'> = prisma) {
  if (typeof input.requestId !== 'string') return null;
  const row = await db.aiJob.findFirst({
    where: {
      userId, kind: 'text',
      AND: [
        { request: { path: ['purpose'], equals: 'continuity-check' } },
        { request: { path: ['requestId'], equals: input.requestId } },
      ],
    },
    select: { id: true, request: true, status: true },
  });
  if (row && !equivalentRequest(row.request, input)) throw new AiHttpError(409, 'Идентификатор уже используется для другой проверки.');
  return row;
}

export async function reserveContinuityJob(userId: string, projectId: string, input: SerializedRequest, ceilingCents: number) {
  return prisma.$transaction(async (tx) => {
    // Тот же ряд и тот же порядок блокировки, что у перевода между кошельками.
    await lockWallets(tx, [userId]);
    const previous = await findContinuityRetry(userId, input, tx);
    if (previous) return { ...previous, existing: true };
    const account = await tx.user.findUnique({ where: { id: userId }, select: { aiBalanceCents: true, settings: true } });
    if (!account) throw new AiHttpError(404, 'Аккаунт не найден');
    const refusal = aiBalanceRefusal(account.aiBalanceCents);
    if (refusal) throw new AiHttpError(402, refusal);
    const wallet = settingsRecord(settingsRecord(account.settings).aiPay).useWallet === true;
    const cents = wallet ? ceilingCents : 0;
    if (cents > account.aiBalanceCents) {
      throw new AiHttpError(402, `Для проверки нужно зарезервировать ${(cents / 100).toFixed(2)} $ на счёте ИИ.`);
    }
    if (cents) await tx.user.update({ where: { id: userId }, data: { aiBalanceCents: { decrement: cents } } });
    const hold: Hold = { version: 1, cents, wallet };
    const row = await tx.aiJob.create({
      data: { userId, projectId, kind: 'text', status: 'queued', request: input as Prisma.InputJsonValue, result: { _continuityHold: hold } },
      select: { id: true, status: true },
    });
    return { ...row, existing: false };
  });
}

type ContinuityTx = Pick<typeof prisma, '$queryRaw'>;
async function lockContinuityJob(tx: ContinuityTx, jobId: string, userId: string) {
  const [row] = await tx.$queryRaw<Array<{ status: string; result: unknown }>>`
    SELECT status, result FROM ai_jobs WHERE id = ${jobId} AND "userId" = ${userId} FOR UPDATE
  `;
  if (!row || row.status !== 'running') return null;
  return { hold: continuityHold(row.result) };
}

export async function finishContinuityJob(
  jobId: string,
  userId: string,
  output: Record<string, unknown>,
  usage: Parameters<typeof recordUsage>[0] & { costUsdMicros: number },
  since: Date,
  limit: number | null,
) {
  return prisma.$transaction(async (tx) => {
    await lockWallets(tx, [userId]);
    const current = await lockContinuityJob(tx, jobId, userId);
    if (!current?.hold) throw new AiHttpError(409, 'Резерв проверки уже завершён.');
    const { hold } = current;
    const chargedCents = hold.wallet && usage.costUsdMicros > 0 ? Math.ceil(usage.costUsdMicros / 10_000) : 0;
    if (chargedCents > hold.cents) {
      throw new AiHttpError(503, 'Стоимость проверки превысила резерв. Средства возвращены.');
    }
    const releasedCents = hold.cents - chargedCents;
    if (releasedCents) await tx.user.update({ where: { id: userId }, data: { aiBalanceCents: { increment: releasedCents } } });
    const receipt = await recordUsage(usage, tx);
    const next = await usageSince(userId, since, tx);
    const result = {
      ...output,
      usage: { receiptId: receipt.id, totalTokens: receipt.totalTokens, costUsdMicros: receipt.costUsdMicros, peak: receipt.peak },
      quota: { used: next.tokens, limit, periodDays: 30 },
      billing: { reservedCents: hold.cents, chargedCents, releasedCents },
    };
    await tx.aiJob.update({
      where: { id: jobId },
      data: { status: 'done', result: result as Prisma.InputJsonValue, error: '', finishedAt: new Date() },
    });
    return result;
  });
}

export async function failContinuityJob(jobId: string, userId: string, error: string) {
  return prisma.$transaction(async (tx) => {
    await lockWallets(tx, [userId]);
    const current = await lockContinuityJob(tx, jobId, userId);
    if (!current) return false;
    const cents = current.hold?.cents ?? 0;
    if (cents) await tx.user.update({ where: { id: userId }, data: { aiBalanceCents: { increment: cents } } });
    await tx.aiJob.update({
      where: { id: jobId },
      data: {
        status: 'failed', error: error.slice(0, 500), finishedAt: new Date(),
        result: { billing: { reservedCents: cents, chargedCents: 0, releasedCents: cents } },
      },
    });
    return true;
  });
}

export async function continuityWalletAmounts(userId: string) {
  const [row] = await prisma.$queryRaw<Array<{ available: number; held: bigint }>>`
    SELECT u."aiBalanceCents" AS available, COALESCE((
      SELECT SUM((j.result->'_continuityHold'->>'cents')::int)
      FROM ai_jobs j
      WHERE j."userId" = u.id AND j.kind = 'text' AND j.status IN ('queued','running')
        AND j.request->>'purpose' = 'continuity-check'
        AND j.result->'_continuityHold'->>'version' = '1'
        AND jsonb_typeof(j.result->'_continuityHold'->'cents') = 'number'
    ), 0)::bigint AS held
    FROM users u WHERE u.id = ${userId}
  `;
  return { availableAiCents: row?.available ?? 0, reservedAiCents: Number(row?.held ?? 0) };
}

export async function chargedContinuityReceipts(userId: string, ids: string[]) {
  if (!ids.length) return new Map<string, number>();
  const found = await prisma.$queryRaw<Array<{ id: string; cents: number }>>`
    SELECT result->'usage'->>'receiptId' AS id, (result->'billing'->>'chargedCents')::int AS cents
    FROM ai_jobs WHERE "userId" = ${userId} AND status = 'done'
      AND result->'usage'->>'receiptId' IN (${Prisma.join(ids)})
  `;
  return new Map(found.map(({ id, cents }) => [id, cents]));
}
