import { logger } from '../logger.js';
import { prisma } from '../prisma.js';
import { noticeAllowed, type NoticeDraft } from './drafts.js';

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
