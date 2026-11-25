import type { Prisma } from '@prisma/client';

import { prisma } from './prisma.js';
import { isStoredDriveTokenEncrypted, readDriveToken, sealDriveToken } from './driveTokenStorage.js';

export async function migrateDriveTokens(checkOnly: boolean) {
  let migrated = 0;
  let plaintext = 0;
  let cursor: string | undefined;
  while (true) {
    const records: Array<{ id: string; userId: string; accessToken: string | null; refreshToken: string | null; updatedAt: Date }> =
      await prisma.userIntegration.findMany({
        where: { provider: 'gdrive', ...(cursor && { id: { gt: cursor } }) },
        orderBy: { id: 'asc' },
        take: 100,
        select: { id: true, userId: true, accessToken: true, refreshToken: true, updatedAt: true },
      });
    if (!records.length) return { migrated, plaintext };
    for (const row of records) {
      const data: Prisma.UserIntegrationUpdateManyMutationInput = {};
      for (const [field, kind] of [['accessToken', 'access'], ['refreshToken', 'refresh']] as const) {
        const token = row[field];
        if (token === null) continue;
        if (isStoredDriveTokenEncrypted(token)) {
          readDriveToken(token, row.userId, kind);
        } else {
          data[field] = sealDriveToken(token, row.userId, kind);
        }
      }
      if (Object.keys(data).length === 0) continue;
      plaintext++;
      if (checkOnly) continue;
      const result = await prisma.userIntegration.updateMany({
        where: {
          id: row.id, provider: 'gdrive', updatedAt: row.updatedAt,
          accessToken: row.accessToken, refreshToken: row.refreshToken,
        },
        data,
      });
      migrated += result.count;
    }
    cursor = records.at(-1)!.id;
  }
}
