import assert from 'node:assert/strict';
import test from 'node:test';

test('Drive tokens and replaced backup IDs stay scoped to their owners', async () => {
  const databaseUrl = process.env.SECURITY_TEST_DATABASE_URL;
  assert.ok(databaseUrl);
  assert.match(new URL(databaseUrl).pathname, /^\/ow_stats_qa_[a-z0-9_]+$/);
  Object.assign(process.env, {
    DATABASE_URL: databaseUrl, NODE_ENV: 'test', LOG_LEVEL: 'fatal',
    BETTER_AUTH_URL: 'http://localhost:42891',
    BETTER_AUTH_SECRET: 'drive-isolation-test-key-not-for-production',
    GOOGLE_CLIENT_ID: 'drive-test', GOOGLE_CLIENT_SECRET: 'drive-test', SENTRY_DSN: '',
  });
  const { prisma } = await import('./prisma.js');
  const { sealDriveToken, readDriveToken, isStoredDriveTokenEncrypted } = await import('./driveTokenStorage.js');
  const { migrateDriveTokens } = await import('./driveTokenMigration.js');
  const { exchangeCodeAndSave, getValidAccessToken } = await import('./gdrive.js');
  const { exportProjectFull, restoreProjectFull } = await import('./projectTransfer.js');
  const key = `drive-audit-${Date.now()}`;
  const realFetch = globalThis.fetch;
  try {
    const owner = await prisma.user.create({ data: { id: key, email: `${key}@example.org`, name: 'Drive QA' } });
    const marker = 'synthetic-drive-token';
    const sealed = sealDriveToken(marker, owner.id, 'refresh');
    assert.equal(readDriveToken(sealed, owner.id, 'refresh'), marker);
    assert.notEqual(sealDriveToken(marker, owner.id, 'refresh'), sealed);
    assert.throws(() => readDriveToken(sealed, 'different-owner', 'refresh'), /integrity verification/);
    assert.throws(() => readDriveToken(sealed, owner.id, 'access'), /integrity verification/);

    await prisma.userIntegration.create({ data: {
      userId: owner.id, provider: 'gdrive', accessToken: 'legacy-access',
      refreshToken: 'legacy-refresh', expiresAt: new Date(Date.now() + 120_000),
    } });
    assert.equal((await migrateDriveTokens(true)).plaintext, 1);
    assert.equal((await migrateDriveTokens(false)).migrated, 1);
    assert.deepEqual(await migrateDriveTokens(true), { migrated: 0, plaintext: 0 });
    assert.equal((await getValidAccessToken(owner.id)).accessToken, 'legacy-access');
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      if (url.hostname === 'oauth2.googleapis.com') {
        return Response.json({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600 });
      }
      assert.equal(url.hostname, 'www.googleapis.com');
      return Response.json({ email: 'fixture-drive@example.org' });
    };
    await exchangeCodeAndSave('fixture-code', owner.id, 'http://localhost:42891', 'fixture-verifier');
    const stored = await prisma.userIntegration.findFirstOrThrow({ where: { userId: owner.id } });
    assert.ok(stored.refreshToken && isStoredDriveTokenEncrypted(stored.refreshToken));
    assert.equal((await getValidAccessToken(owner.id)).accessToken, 'new-access');

    const original = await prisma.project.create({ data: { ownerId: owner.id, name: 'Original' } });
    const place = await prisma.location.create({ data: { projectId: original.id, name: 'Place' } });
    const child = await prisma.location.create({ data: { projectId: original.id, name: 'Child', parentLocationId: place.id } });
    const backup = await exportProjectFull(original.id);
    backup.tables.locations = backup.tables.locations.map(row => ({ ...row as object, ignoredField: true }));
    const restored = await restoreProjectFull(owner.id, backup);
    const locations = await prisma.location.findMany({ where: { projectId: restored.projectId } });
    assert.equal(locations.length, 2);
    assert.equal(locations.find(row => row.name === child.name)?.parentLocationId,
      locations.find(row => row.name === place.name)?.id);
    assert.notEqual(locations.find(row => row.name === child.name)?.id, child.id);
    assert.equal(await prisma.location.count({ where: { projectId: original.id } }), 2);
  } finally {
    globalThis.fetch = realFetch;
    await prisma.$disconnect();
  }
});
