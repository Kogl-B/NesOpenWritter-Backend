import { migrateDriveTokens } from '../lib/driveTokenMigration.js';
import { prisma } from '../lib/prisma.js';

try {
  const mode = process.argv[2];
  if (mode !== '--apply' && mode !== '--check') throw new Error('Missing mode');
  const result = await migrateDriveTokens(mode === '--check');
  console.log(JSON.stringify(result));
  if (mode === '--check' && result.plaintext !== 0) process.exitCode = 1;
} catch {
  console.error('DRIVE_TOKEN_MIGRATION_FAILED');
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
