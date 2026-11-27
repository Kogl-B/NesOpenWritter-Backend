import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { xlsxWorkbook } from './xlsx.js';
import { prisma } from './prisma.js';

export const earningsPeriod = z.coerce.number().int().pipe(z.union([z.literal(7), z.literal(30), z.literal(90), z.literal(0)])).default(30);
export const earningsListQuery = z.object({
  days: earningsPeriod,
  q: z.string().trim().max(80).default(''),
  level: z.string().trim().max(80).default(''),
  status: z.enum(['all', 'paid', 'free', 'granted', 'ended']).default('all'),
  kind: z.enum(['all', 'donation', 'joined', 'renewed', 'upgraded', 'changed', 'cancelled', 'followed']).default('all'),
  sort: z.enum(['recent', 'oldest', 'income']).default('recent'),
  page: z.coerce.number().int().min(1).max(100000).default(1),
});
type ListFilter = z.infer<typeof earningsListQuery>;
type Earned = { subscriptionCents: number; donationCents: number };
type Totals = Earned & { totalSubscriptionCents: number; totalDonationCents: number; donations: number };
type Activity = { id: string; name: string; title: string; kind: string; cents: number; note: string; at: Date };
type Subscriber = {
  id: string; name: string; levelId: string | null; title: string; priceRub: number; status: string;
  incomeCents: number; lastCents: number; joined: Date; ended: Date | null; expiresAt: Date | null;
};
const pageSize = 50;
const startOf = (days: number) => new Date(Math.floor(Date.now() / 86400000) * 86400000 - (days - 1) * 86400000);
const dateText = (value: Date | null) => value?.toISOString() ?? '';

function ledger(authorId: string) {
  return Prisma.sql`
    SELECT id, "senderId" AS actor, "postTitle" AS title, 'donation' AS kind, "amountCents" AS cents,
           note, "createdAt" AS at FROM blog_wallet_donations WHERE "authorId" = ${authorId}
    UNION ALL
    SELECT id, "userId" AS actor, "levelTitle" AS title, kind, "amountCents" AS cents,
           reason AS note, "createdAt" AS at FROM blog_audience_events WHERE "authorId" = ${authorId}
  `;
}

export async function blogEarnings(authorId: string, days: number, full = false) {
  const then = days ? startOf(days) : new Date(0);
  const day = days ? then.toISOString().slice(0, 10) : '';
  const now = new Date();
  return prisma.$transaction(async (db) => {
    const [owner, paid, free, observers, totals, activity, series, traffic, reasons, levels, newsletters] = await Promise.all([
      db.user.findUniqueOrThrow({ where: { id: authorId }, select: { walletBalanceCents: true } }),
      db.authorSubscription.count({ where: { authorId, expiresAt: { gt: now } } }),
      db.authorSubscription.count({ where: { authorId, expiresAt: null } }),
      db.authorFollow.count({ where: { authorId } }),
      db.$queryRaw<Totals[]>`
        SELECT COALESCE(SUM(cents) FILTER (WHERE kind <> 'donation'),0)::float8 AS "totalSubscriptionCents",
          COALESCE(SUM(cents) FILTER (WHERE kind = 'donation'),0)::float8 AS "totalDonationCents",
          COALESCE(SUM(cents) FILTER (WHERE kind <> 'donation' AND at >= ${then}),0)::float8 AS "subscriptionCents",
          COALESCE(SUM(cents) FILTER (WHERE kind = 'donation' AND at >= ${then}),0)::float8 AS "donationCents",
          COUNT(*) FILTER (WHERE kind = 'donation' AND at >= ${then})::int AS donations
        FROM (${ledger(authorId)}) AS ledger
      `,
      db.blogAudienceEvent.groupBy({ by: ['kind'], where: { authorId, createdAt: { gte: then } }, _count: { _all: true } }),
      db.$queryRaw<Array<Earned & { day: string }>>`
        SELECT to_char(at, ${days ? 'YYYY-MM-DD' : 'YYYY-MM'}) AS day,
          COALESCE(SUM(cents) FILTER (WHERE kind <> 'donation'),0)::float8 AS "subscriptionCents",
          COALESCE(SUM(cents) FILTER (WHERE kind = 'donation'),0)::float8 AS "donationCents"
        FROM (${ledger(authorId)}) AS ledger
        WHERE cents > 0 AND at >= ${then} GROUP BY 1 ORDER BY 1
      `,
      db.$queryRaw<Array<{ source: string; views: number }>>`
        SELECT source, SUM(views)::float8 AS views FROM blog_traffic_days
        WHERE "authorId" = ${authorId} AND day >= ${day} GROUP BY source ORDER BY views DESC
      `,
      db.blogAudienceEvent.groupBy({ by: ['reason'], where: { authorId, kind: 'cancelled', createdAt: { gte: then } }, _count: { _all: true } }),
      db.authorLevel.findMany({ where: { authorId }, select: { id: true, title: true }, orderBy: { priceRub: 'asc' } }),
      db.$queryRaw<Array<{ id: string; title: string; at: Date; recipients: number }>>`
        SELECT p.id, p.title, MIN(n."createdAt") AS at, COUNT(DISTINCT n."userId")::int AS recipients
        FROM notifications n JOIN blog_posts p ON n.href = ('/blog/' || p.id)
        WHERE p."authorId" = ${authorId} AND n.kind = 'blog_post' AND n."createdAt" >= ${then}
        GROUP BY p.id, p.title ORDER BY at DESC ${full ? Prisma.empty : Prisma.sql`LIMIT 50`}
      `,
    ]);
    return {
      balanceCents: Number(owner.walletBalanceCents), paid, subscribers: paid + free, observers, ...totals[0]!,
      counters: Object.fromEntries(activity.map((row) => [row.kind, row._count._all])),
      series, traffic, reasons: reasons.map(({ reason, _count }) => ({ reason, count: _count._all })), levels, newsletters,
    };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
}

export async function earningsActivities(authorId: string, filter: ListFilter, area: 'events' | 'donations', all = false) {
  const { kind, q, days, sort, page } = filter;
  const filters = [
    days ? Prisma.sql`l.at >= ${startOf(days)}` : Prisma.sql`TRUE`,
    q ? Prisma.sql`strpos(lower(COALESCE(u.name,'')), lower(${q})) > 0` : Prisma.sql`TRUE`,
    area === 'donations' || kind !== 'all' ? Prisma.sql`l.kind = ${area === 'donations' ? 'donation' : kind}` : Prisma.sql`TRUE`,
  ];
  const limit = area === 'events' ? 12 : pageSize;
  const order = sort === 'oldest' ? Prisma.sql`l.at ASC` : sort === 'income' ? Prisma.sql`l.cents DESC, l.at DESC` : Prisma.sql`l.at DESC`;
  const rows = await prisma.$queryRaw<Activity[]>`
    SELECT l.id, COALESCE(NULLIF(trim(u.name),''), 'Читатель') AS name, l.title, l.kind, l.cents, l.note, l.at
    FROM (${ledger(authorId)}) l LEFT JOIN users u ON u.id = l.actor WHERE ${Prisma.join(filters, ' AND ')}
    ORDER BY ${order}, l.id ${all ? Prisma.empty : Prisma.sql`LIMIT ${limit + 1} OFFSET ${(page - 1) * limit}`}
  `;
  return { rows: all ? rows : rows.slice(0, limit), more: !all && rows.length > limit };
}

export async function earningsSubscribers(authorId: string, filter: ListFilter, all = false) {
  const { q, level, status, sort, page } = filter;
  const order = sort === 'income' ? Prisma.sql`"incomeCents" DESC, joined DESC` : sort === 'oldest' ? Prisma.sql`joined ASC` : Prisma.sql`joined DESC`;
  const clock = new Date();
  const rows = await prisma.$queryRaw<Subscriber[]>`
    WITH history AS (
      SELECT * FROM blog_audience_events WHERE "authorId" = ${authorId} AND "levelId" IS NOT NULL
    ), latest AS (
      SELECT DISTINCT ON ("userId") "userId","levelId","levelTitle","priceRub"
      FROM history ORDER BY "userId","createdAt" DESC, id DESC
    ), totals AS (
      SELECT "userId", MIN("createdAt") FILTER (WHERE kind = 'joined') AS joined,
        MAX("createdAt") FILTER (WHERE kind = 'cancelled') AS ended, SUM("amountCents")::float8 AS income
      FROM history GROUP BY "userId"
    ), charges AS (
      SELECT DISTINCT ON ("userId") "userId","amountCents" FROM history WHERE "amountCents" > 0
      ORDER BY "userId","createdAt" DESC, id DESC
    ), readers AS (
      SELECT "userId" FROM author_subscriptions WHERE "authorId" = ${authorId}
      UNION SELECT "userId" FROM latest
    ), report AS (
      SELECT r."userId" AS id, COALESCE(NULLIF(trim(u.name),''), 'Читатель') AS name,
        COALESCE(s."levelId", h."levelId") AS "levelId", COALESCE(l.title, h."levelTitle", '') AS title,
        COALESCE(l."priceRub", h."priceRub", 0) AS "priceRub",
        CASE WHEN s.id IS NULL OR s."expiresAt" <= ${clock} THEN 'ended'
             WHEN s."expiresAt" IS NOT NULL THEN 'paid'
             WHEN l."priceRub" > 0 THEN 'granted' ELSE 'free' END AS status,
        COALESCE(t.income,0)::float8 AS "incomeCents", COALESCE(c."amountCents",0)::int AS "lastCents",
        COALESCE(LEAST(s."createdAt", t.joined), t.ended) AS joined,
        CASE WHEN s.id IS NULL THEN t.ended WHEN s."expiresAt" <= ${clock} THEN s."expiresAt"
             ELSE s."cancelledAt" END AS ended, s."expiresAt"
      FROM readers r LEFT JOIN users u ON u.id = r."userId"
      LEFT JOIN author_subscriptions s ON s."authorId" = ${authorId} AND s."userId" = r."userId"
      LEFT JOIN author_levels l ON l.id = s."levelId"
      LEFT JOIN latest h ON h."userId" = r."userId"
      LEFT JOIN totals t ON t."userId" = r."userId"
      LEFT JOIN charges c ON c."userId" = r."userId"
    )
    SELECT * FROM report WHERE (${q} = '' OR strpos(lower(name), lower(${q})) > 0)
      AND (${level} = '' OR "levelId" = ${level})
      AND (${status} = 'all' OR status = ${status})
    ORDER BY ${order}, id ${all ? Prisma.empty : Prisma.sql`LIMIT ${pageSize + 1} OFFSET ${(page - 1) * pageSize}`}
  `;
  return { rows: all ? rows : rows.slice(0, pageSize), more: !all && rows.length > pageSize };
}

const kinds: Record<string, string> = { donation: 'Донат', joined: 'Подписка', renewed: 'Продление', upgraded: 'Повышение уровня', changed: 'Смена уровня', cancelled: 'Отписка', followed: 'Наблюдатель' };
const statuses: Record<string, string> = { paid: 'Оплачена', free: 'Бесплатная', granted: 'Доступ выдан автором', ended: 'Завершена' };
const sources: Record<string, string> = { direct: 'Прямой переход', site: 'OpenWritter', search: 'Поиск', social: 'Соцсети', external: 'Другие сайты', unknown: 'Источник неизвестен' };
const reasons: Record<string, string> = { price: 'Цена', content: 'Темы публикаций', rarely_read: 'Редко читаю блог', other: 'Другая причина', '': 'Без объяснения' };

export async function exportBlogEarnings(authorId: string) {
  const filter = earningsListQuery.parse({ days: 0 });
  const [summary, people, events] = await Promise.all([
    blogEarnings(authorId, 0, true),
    earningsSubscribers(authorId, filter, true),
    earningsActivities(authorId, filter, 'events', true),
  ]);
  return xlsxWorkbook([
    { name: 'Статистика', rows: [['Показатель', 'Значение'], ['Остаток кошелька, BYN', summary.balanceCents / 100],
      ['Подписки, BYN', summary.totalSubscriptionCents / 100], ['Донаты, BYN', summary.totalDonationCents / 100],
      ['Всего заработано, BYN', (summary.totalSubscriptionCents + summary.totalDonationCents) / 100],
      ['Активные подписчики', summary.subscribers], ['Оплатившие подписку', summary.paid], ['Наблюдатели', summary.observers]] },
    { name: 'Подписчики', rows: [['Имя', 'Уровень', 'Статус', 'Цена уровня, RUB', 'Последний платёж, BYN', 'Доход, BYN', 'Начало, UTC', 'Отмена, UTC', 'Доступ до, UTC'],
      ...people.rows.map((row) => [row.name, row.title, statuses[row.status] ?? row.status, row.priceRub, row.lastCents / 100, row.incomeCents / 100, dateText(row.joined), dateText(row.ended), dateText(row.expiresAt)])] },
    { name: 'Донаты', rows: [['Имя', 'Пост', 'Сумма, BYN', 'Сообщение', 'Дата, UTC'],
      ...events.rows.filter((row) => row.kind === 'donation').map((row) => [row.name, row.title, row.cents / 100, row.note, dateText(row.at)])] },
    { name: 'События', rows: [['Дата, UTC', 'Действие', 'Имя', 'Пост или уровень', 'Сумма, BYN', 'Комментарий'],
      ...events.rows.map((row) => [dateText(row.at), kinds[row.kind] ?? row.kind, row.name, row.title, row.cents / 100, row.kind === 'cancelled' ? reasons[row.note] ?? row.note : row.note])] },
    { name: 'Трафик', rows: [['Источник', 'Просмотры'], ...summary.traffic.map((row) => [sources[row.source] ?? row.source, row.views])] },
    { name: 'Рассылки', rows: [['Публикация', 'Получатели', 'Дата, UTC'],
      ...summary.newsletters.map((row) => [row.title, row.recipients, dateText(row.at)])] },
    { name: 'Причины отписки', rows: [['Причина', 'Количество'], ...summary.reasons.map((row) => [reasons[row.reason] ?? row.reason, row.count])] },
  ]);
}
