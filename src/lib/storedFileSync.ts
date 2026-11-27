import { prisma } from './prisma.js';
import { isR2Configured, listUserObjects } from './r2.js';
import { parseStoredKey } from './storedFiles.js';

const synced = new Set<string>();

/** Подтягивает уже лежащие в кабинете файлы в учёт места. Повторно за один процесс не ходит в хранилище. */
export async function syncStoredFiles(userId: string): Promise<void> {
  if (synced.has(userId) || !isR2Configured()) return;
  let objects: Array<{ key: string; sizeBytes: number }>;
  try {
    objects = await Promise.race([
      listUserObjects(userId),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('timeout')), 8000);
      }),
    ]);
  } catch {
    return;
  }
  const parsed = objects.flatMap((object) => {
    const place = parseStoredKey(object.key, userId);
    return place ? [{ ...object, ...place }] : [];
  });
  const ids = [...new Set(parsed.map((object) => object.projectId))];
  const owned = new Set(
    ids.length === 0
      ? []
      : (await prisma.project.findMany({
        where: { id: { in: ids }, ownerId: userId },
        select: { id: true },
      })).map((project) => project.id),
  );
  for (const object of parsed) {
    await prisma.storedFile.upsert({
      where: { key: object.key },
      create: {
        userId,
        projectId: owned.has(object.projectId) ? object.projectId : null,
        key: object.key,
        sizeBytes: object.sizeBytes,
        kind: object.kind,
      },
      update: { sizeBytes: object.sizeBytes },
    });
  }
  synced.add(userId);
}

export async function rememberStoredFile(input: {
  userId: string;
  projectId: string | null;
  key: string;
  sizeBytes: number;
  kind: string;
}): Promise<void> {
  await prisma.storedFile.upsert({
    where: { key: input.key },
    create: input,
    update: { sizeBytes: input.sizeBytes, kind: input.kind },
  });
}
