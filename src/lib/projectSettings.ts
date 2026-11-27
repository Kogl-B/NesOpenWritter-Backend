import type { Prisma } from '@prisma/client';

import { getProjectAccess } from './access.js';
import { AiHttpError } from './ai/aiError.js';
import { prisma } from './prisma.js';

function settingsOf(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return { ...(value as Record<string, unknown>) };
}

/** Меняет настройки книги под блокировкой строки, чтобы параллельное сохранение не затёрло фото. */
export async function lockProjectSettings(
  projectId: string,
  userId: string,
  mutate: (settings: Record<string, unknown>) => Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const role = await getProjectAccess(projectId, userId);
  if (!role || role === 'viewer') throw new AiHttpError(403, 'Нет права записать результат в книгу');
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<Array<{ settings: unknown }>>`
      SELECT settings FROM projects WHERE id = ${projectId} FOR UPDATE
    `;
    const row = rows[0];
    if (!row) throw new AiHttpError(404, 'Книга не найдена');
    const next = mutate(settingsOf(row.settings));
    await tx.project.update({
      where: { id: projectId },
      data: { settings: next as Prisma.InputJsonValue },
    });
    return next;
  });
}
