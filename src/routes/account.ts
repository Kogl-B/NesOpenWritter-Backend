import type { FastifyPluginAsync } from 'fastify';
import { Prisma } from '@prisma/client';
import { z } from 'zod';

import { prisma } from '../lib/prisma.js';
import { TIERS, DEFAULT_TIER, MB, getTier, isTierId, tierPrices } from '../lib/tiers.js';
import { getRates, bynPerUnit } from '../lib/currency.js';

const planUpdateSchema = z.object({ plan: z.string().trim().min(1).max(32) });

/**
 * Занятое место пользователя: сумма байтов текстовых/JSON-полей всех
 * сущностей его проектов. Колонки camelCase (в схеме нет @map на полях),
 * таблицы — snake_case (@@map). Загрузки в R2 пока не настроены; когда
 * появятся, к этой сумме добавится учёт по объектам хранилища.
 */
const storageSql = (userId: string) => Prisma.sql`
  SELECT
    COALESCE((SELECT SUM(OCTET_LENGTH(pr."name") + OCTET_LENGTH(COALESCE(pr."description",'')) + OCTET_LENGTH(pr."settings"::text))
      FROM projects pr WHERE pr."ownerId" = ${userId}), 0)
  + COALESCE((SELECT SUM(OCTET_LENGTH(ch."name") + OCTET_LENGTH(COALESCE(ch."shortName",'')) + OCTET_LENGTH(COALESCE(ch."summary",''))
      + OCTET_LENGTH(COALESCE(ch."biography",'')) + OCTET_LENGTH(COALESCE(ch."faction",'')) + OCTET_LENGTH(ch."metadata"::text))
      FROM characters ch JOIN projects p ON ch."projectId" = p.id WHERE p."ownerId" = ${userId}), 0)
  + COALESCE((SELECT SUM(OCTET_LENGTH(COALESCE(cr."description",'')))
      FROM character_relations cr JOIN projects p ON cr."projectId" = p.id WHERE p."ownerId" = ${userId}), 0)
  + COALESCE((SELECT SUM(OCTET_LENGTH(it."name") + OCTET_LENGTH(COALESCE(it."shortName",'')) + OCTET_LENGTH(COALESCE(it."summary",''))
      + OCTET_LENGTH(COALESCE(it."description",'')) + OCTET_LENGTH(it."properties"::text) + OCTET_LENGTH(it."metadata"::text))
      FROM items it JOIN projects p ON it."projectId" = p.id WHERE p."ownerId" = ${userId}), 0)
  + COALESCE((SELECT SUM(OCTET_LENGTH(COALESCE(tp."note",'')))
      FROM item_timeline_points tp JOIN projects p ON tp."projectId" = p.id WHERE p."ownerId" = ${userId}), 0)
  + COALESCE((SELECT SUM(OCTET_LENGTH(lo."name") + OCTET_LENGTH(COALESCE(lo."shortName",''))
      + OCTET_LENGTH(COALESCE(lo."description",'')) + OCTET_LENGTH(lo."metadata"::text))
      FROM locations lo JOIN projects p ON lo."projectId" = p.id WHERE p."ownerId" = ${userId}), 0)
  + COALESCE((SELECT SUM(OCTET_LENGTH(te."name") + OCTET_LENGTH(COALESCE(te."summary",''))
      + OCTET_LENGTH(COALESCE(te."description",'')) + OCTET_LENGTH(te."metadata"::text))
      FROM timeline_events te JOIN projects p ON te."projectId" = p.id WHERE p."ownerId" = ${userId}), 0)
  + COALESCE((SELECT SUM(OCTET_LENGTH(COALESCE(ec."note",'')))
      FROM event_characters ec JOIN timeline_events te ON ec."eventId" = te.id
      JOIN projects p ON te."projectId" = p.id WHERE p."ownerId" = ${userId}), 0)
  + COALESCE((SELECT SUM(OCTET_LENGTH(COALESCE(ei."note",'')))
      FROM event_items ei JOIN timeline_events te ON ei."eventId" = te.id
      JOIN projects p ON te."projectId" = p.id WHERE p."ownerId" = ${userId}), 0)
  + COALESCE((SELECT SUM(OCTET_LENGTH(cp."title") + OCTET_LENGTH(COALESCE(cp."summary",''))
      + OCTET_LENGTH(cp."content"::text) + OCTET_LENGTH(cp."metadata"::text))
      FROM chapters cp JOIN projects p ON cp."projectId" = p.id WHERE p."ownerId" = ${userId}), 0)
  + COALESCE((SELECT SUM(OCTET_LENGTH(COALESCE(rv."label",'')) + OCTET_LENGTH(rv."content"::text))
      FROM chapter_revisions rv JOIN chapters c2 ON rv."chapterId" = c2.id JOIN projects p ON c2."projectId" = p.id
      WHERE p."ownerId" = ${userId}), 0)
  + COALESCE((SELECT SUM(OCTET_LENGTH(tg."name") + OCTET_LENGTH(COALESCE(tg."description",'')))
      FROM tags tg JOIN projects p ON tg."projectId" = p.id WHERE p."ownerId" = ${userId}), 0)
  + COALESCE((SELECT SUM(OCTET_LENGTH(me."name") + OCTET_LENGTH(COALESCE(me."description",''))
      + OCTET_LENGTH(me."geometry"::text) + OCTET_LENGTH(me."style"::text) + OCTET_LENGTH(me."metadata"::text))
      FROM map_elements me JOIN projects p ON me."projectId" = p.id WHERE p."ownerId" = ${userId}), 0)
  + COALESCE((SELECT SUM(OCTET_LENGTH(md."name") + OCTET_LENGTH(md."payload"::text))
      FROM map_drawings md JOIN projects p ON md."projectId" = p.id WHERE p."ownerId" = ${userId}), 0)
  + COALESCE((SELECT SUM(OCTET_LENGTH(wp."title") + OCTET_LENGTH(wp."content") + OCTET_LENGTH(wp."links"::text))
      FROM wiki_pages wp JOIN projects p ON wp."projectId" = p.id WHERE p."ownerId" = ${userId}), 0)
  + COALESCE((SELECT SUM(OCTET_LENGTH(ws."name") + OCTET_LENGTH(COALESCE(ws."description",'')) + OCTET_LENGTH(ws."state"::text))
      FROM world_snapshots ws JOIN projects p ON ws."projectId" = p.id WHERE p."ownerId" = ${userId}), 0)
  + COALESCE((SELECT SUM(OCTET_LENGTH(ke."topic") + OCTET_LENGTH(COALESCE(ke."detail",'')))
      FROM knowledge_entries ke JOIN projects p ON ke."projectId" = p.id WHERE p."ownerId" = ${userId}), 0)
  + COALESCE((SELECT SUM(OCTET_LENGTH(cu."name") + OCTET_LENGTH(cu."code") + OCTET_LENGTH(cu."exchangeRate"::text))
      FROM currencies cu JOIN projects p ON cu."projectId" = p.id WHERE p."ownerId" = ${userId}), 0)
  + COALESCE((SELECT SUM(OCTET_LENGTH(rs."name") + OCTET_LENGTH(COALESCE(rs."description",'')))
      FROM resources rs JOIN projects p ON rs."projectId" = p.id WHERE p."ownerId" = ${userId}), 0)
  + COALESCE((SELECT SUM(OCTET_LENGTH(tr."name") + OCTET_LENGTH(COALESCE(tr."description",'')))
      FROM trade_routes tr JOIN projects p ON tr."projectId" = p.id WHERE p."ownerId" = ${userId}), 0)
  + COALESCE((SELECT SUM(OCTET_LENGTH(ca."name") + OCTET_LENGTH(ca."epochName") + OCTET_LENGTH(ca."settings"::text))
      FROM calendars ca JOIN projects p ON ca."projectId" = p.id WHERE p."ownerId" = ${userId}), 0)
  + COALESCE((SELECT SUM(OCTET_LENGTH(ip."label") + OCTET_LENGTH(COALESCE(ip."note",'')))
      FROM investigation_pins ip JOIN projects p ON ip."projectId" = p.id WHERE p."ownerId" = ${userId}), 0)
  + COALESCE((SELECT SUM(OCTET_LENGTH(COALESCE(ith."label",'')))
      FROM investigation_threads ith JOIN projects p ON ith."projectId" = p.id WHERE p."ownerId" = ${userId}), 0)
  AS total
`;

export async function getUserPlan(userId: string): Promise<string> {
  const row = await prisma.user.findUnique({ where: { id: userId }, select: { plan: true } });
  return row?.plan ?? DEFAULT_TIER;
}

export async function getStorageUsedBytes(userId: string): Promise<number> {
  const rows = await prisma.$queryRaw<Array<{ total: bigint | number }>>(storageSql(userId));
  const total = rows[0]?.total;
  return typeof total === 'bigint' ? Number(total) : Number(total ?? 0);
}

export interface UsageInfo {
  plan: string;
  planName: string;
  projects: { used: number; limit: number | null };
  storage: { usedBytes: number; limitBytes: number | null };
}

export async function getUsageInfo(userId: string): Promise<UsageInfo> {
  const tier = getTier(await getUserPlan(userId));
  const [owned, usedBytes] = await Promise.all([
    prisma.project.count({ where: { ownerId: userId } }),
    getStorageUsedBytes(userId),
  ]);
  return {
    plan: tier.id,
    planName: tier.name,
    projects: { used: owned, limit: tier.projectLimit },
    storage: {
      usedBytes,
      limitBytes: tier.storageLimitMb == null ? null : tier.storageLimitMb * MB,
    },
  };
}

export const accountRoutes: FastifyPluginAsync = async (app) => {
  // Витрина тарифов — публичная. Цены пересчитываются из BYN по курсу НБ РБ
  // (обновление раз в сутки после 12:00 по Минску, см. lib/currency.ts)
  app.get('/api/tiers', async () => {
    const rates = await getRates();
    const bynUsd = bynPerUnit(rates.USD);
    const bynRub = bynPerUnit(rates.RUB);
    return {
      tiers: TIERS.map((t) => ({
        id: t.id,
        name: t.name,
        priceByn: t.priceByn,
        projectLimit: t.projectLimit,
        storageLimitMb: t.storageLimitMb,
        features: t.features,
        prices: tierPrices(t.priceByn, bynUsd, bynRub),
      })),
      currency: {
        base: 'BYN',
        source: 'НБ РБ',
        // дата курса, приведённая к «на какой день» для подписи в UI
        rateDate: rates.USD.updatedAt,
        fetchedAt: rates.fetchedAt,
        stale: rates.stale,
        perUnit: { USD: bynUsd, RUB: bynRub },
      },
    };
  });

  app.get('/api/account/usage', async (req) => {
    app.requireAuth(req);
    return getUsageInfo(req.user!.id);
  });

  app.patch('/api/account/plan', async (req, reply) => {
    app.requireAuth(req);
    const input = planUpdateSchema.parse(req.body);
    if (!isTierId(input.plan)) {
      return reply.status(400).send({ error: `Неизвестный тариф: ${input.plan}` });
    }
    const tier = getTier(input.plan);
    const owned = await prisma.project.count({ where: { ownerId: req.user!.id } });
    await prisma.user.update({
      where: { id: req.user!.id },
      data: { plan: tier.id },
    });
    const usage = await getUsageInfo(req.user!.id);
    // Даунгрейд с превышением лимита проектов: существующие не удаляем,
    // но предупреждаем — новые создать будет нельзя
    const warning =
      tier.projectLimit != null && owned > tier.projectLimit
        ? `У вас ${owned} проектов, а тариф «${tier.name}» допускает ${tier.projectLimit}. Проекты остались на месте, но создать новый не получится, пока не освободите место.`
        : null;
    return { ...usage, warning };
  });
};
