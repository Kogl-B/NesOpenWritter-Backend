import { logger } from '../logger.js';
import { prisma } from '../prisma.js';
import {
  applyDigest,
  digestHeading,
  noticeAllowed,
  type DigestBucket,
  type NoticeDraft,
} from './drafts.js';

export async function deliverNotices(drafts: NoticeDraft[]): Promise<void> {
  const unique = new Map<string, NoticeDraft>();
  for (const draft of drafts) {
    if (!draft.userId) continue;
    unique.set(`${draft.userId}:${draft.eventKey}`, draft);
  }
  const rows = [...unique.values()];
  if (rows.length === 0) return;
  const users = await prisma.user.findMany({
    where: { id: { in: [...new Set(rows.map((row) => row.userId))] } },
    select: { id: true, settings: true },
  });
  const settings = new Map(users.map((user) => [user.id, user.settings]));
  const kept = rows.filter((row) => settings.has(row.userId) && noticeAllowed(settings.get(row.userId), row.kind));
  if (kept.length === 0) return;
  await prisma.notification.createMany({
    data: kept.map((row) => ({
      userId: row.userId,
      kind: row.kind,
      title: row.title,
      body: row.body,
      href: row.href,
      eventKey: row.eventKey,
    })),
    skipDuplicates: true,
  });
}

/** Событие уже сохранено. Сбой ящика не отменяет комментарий, главу или запись. */
export async function writeNotices(drafts: NoticeDraft[]): Promise<void> {
  try {
    await deliverNotices(drafts);
  } catch (err) {
    logger.error({ err }, 'Не удалось записать уведомления');
  }
}

export async function writeDigest(input: {
  ownerId: string;
  actorId: string;
  bucket: DigestBucket;
  on: boolean;
  subject: string;
  href: string;
  eventKey: string;
}): Promise<void> {
  if (!input.ownerId || !input.actorId || input.ownerId === input.actorId || !input.eventKey) return;
  try {
    const user = await prisma.user.findUnique({
      where: { id: input.ownerId },
      select: { settings: true },
    });
    if (!user || !noticeAllowed(user.settings, 'digest')) return;
    await saveDigest(input);
  } catch (err) {
    if (!uniqueHit(err)) {
      logger.error({ err }, 'Не удалось записать сводку');
      return;
    }
    try {
      await saveDigest(input);
    } catch (retryErr) {
      logger.error({ err: retryErr }, 'Не удалось записать сводку');
    }
  }
}

async function saveDigest(input: {
  ownerId: string;
  actorId: string;
  bucket: DigestBucket;
  on: boolean;
  subject: string;
  href: string;
  eventKey: string;
}): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const existing = await tx.notification.findUnique({
      where: { userId_eventKey: { userId: input.ownerId, eventKey: input.eventKey } },
    });
    const nextBody = applyDigest(existing?.body ?? '', input.bucket, input.actorId, input.on);
    if (existing && nextBody === existing.body) return;
    if (!nextBody) {
      if (existing) await tx.notification.delete({ where: { id: existing.id } });
      return;
    }
    const data = {
      title: digestHeading(input.subject),
      body: nextBody,
      href: input.href,
      readAt: null,
      createdAt: new Date(),
    };
    if (existing) {
      await tx.notification.update({ where: { id: existing.id }, data });
      return;
    }
    await tx.notification.create({
      data: {
        userId: input.ownerId,
        kind: 'digest',
        eventKey: input.eventKey,
        ...data,
      },
    });
  });
}

function uniqueHit(err: unknown): boolean {
  return Boolean(err && typeof err === 'object' && 'code' in err && (err as { code?: string }).code === 'P2002');
}
