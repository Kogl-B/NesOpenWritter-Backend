import assert from 'node:assert/strict';
import test from 'node:test';

test('project-scoped operations preserve the other project and allow normal edits', async () => {
  const databaseUrl = process.env.SECURITY_TEST_DATABASE_URL;
  assert.ok(databaseUrl);
  assert.match(new URL(databaseUrl).pathname, /^\/ow_stats_qa_[a-z0-9_]+$/);
  const origin = 'http://localhost:42891';
  Object.assign(process.env, {
    DATABASE_URL: databaseUrl, NODE_ENV: 'test', LOG_LEVEL: 'fatal',
    BETTER_AUTH_URL: origin, FRONTEND_URL: origin, CORS_ORIGIN: origin,
    BETTER_AUTH_SECRET: 'security-test-only-not-a-production-secret',
    REQUIRE_EMAIL_VERIFICATION: 'false', RESEND_API_KEY: '', SENTRY_DSN: '',
  });

  const { buildApp } = await import('../app.js');
  const { prisma } = await import('../lib/prisma.js');
  const app = await buildApp();
  const stamp = Date.now();
  try {
    const signUp = await app.inject({
      method: 'POST', url: '/api/auth/sign-up/email', headers: { origin },
      payload: { email: `isolation-${stamp}@example.org`, password: 'IsolatedPassword123', name: 'Isolation QA' },
    });
    assert.equal(signUp.statusCode, 200);
    const userId: string = signUp.json().user.id;
    const cookie = signUp.cookies.map(c => c.name + '=' + encodeURIComponent(c.value)).join('; ');
    const another = await prisma.user.create({
      data: { id: `isolation-other-${stamp}`, name: 'Another QA owner', email: `another-${stamp}@example.org` },
    });
    const own = await prisma.project.create({ data: { ownerId: userId, name: 'Own' } });
    const other = await prisma.project.create({ data: { ownerId: another.id, name: 'Other' } });
    const request = (method: 'GET' | 'PATCH' | 'POST' | 'DELETE', path: string, payload?: object) =>
      app.inject({ method, url: '/api/projects/' + own.id + path, headers: { origin, cookie }, payload });

    const ownCalendar = await prisma.calendar.create({ data: { projectId: own.id, name: 'Calendar', isDefault: true } });
    const otherCalendar = await prisma.calendar.create({ data: { projectId: other.id, name: 'Other calendar' } });
    assert.equal((await request('PATCH', '/calendars/' + otherCalendar.id, { name: 'Updated', isDefault: true })).statusCode, 404);
    assert.equal((await prisma.calendar.findUniqueOrThrow({ where: { id: ownCalendar.id } })).isDefault, true);
    assert.equal((await prisma.calendar.findUniqueOrThrow({ where: { id: otherCalendar.id } })).name, 'Other calendar');
    assert.equal((await request('PATCH', '/calendars/' + ownCalendar.id, { name: 'Updated' })).statusCode, 200);

    const ownPin = await prisma.investigationPin.create({ data: { projectId: own.id, label: 'Own pin' } });
    const otherPin = await prisma.investigationPin.create({ data: { projectId: other.id, label: 'Other pin' } });
    assert.equal((await request('POST', '/investigation/threads', { fromPinId: ownPin.id, toPinId: otherPin.id })).statusCode, 404);
    assert.equal((await request('DELETE', '/investigation/pins/' + otherPin.id)).statusCode, 404);
    assert.equal(await prisma.investigationPin.count({ where: { id: otherPin.id } }), 1);
    const second = await prisma.investigationPin.create({ data: { projectId: own.id, label: 'Second pin' } });
    assert.equal((await request('POST', '/investigation/threads', { fromPinId: ownPin.id, toPinId: second.id })).statusCode, 201);
    assert.equal((await request('DELETE', '/investigation/pins/' + second.id)).statusCode, 204);
    assert.equal(await prisma.investigationThread.count({ where: { toPinId: second.id } }), 0);

    const character = await prisma.character.create({ data: { projectId: other.id, name: 'Other character' } });
    const knowledge = await prisma.knowledgeEntry.create({ data: { projectId: other.id, characterId: character.id, topic: 'Topic', known: true } });
    assert.equal((await request('POST', '/knowledge', { characterId: character.id, topic: 'Topic', known: false })).statusCode, 404);
    assert.equal((await prisma.knowledgeEntry.findUniqueOrThrow({ where: { id: knowledge.id } })).known, true);

    const currency = await prisma.currency.create({ data: { projectId: other.id, name: 'Other currency', code: 'XYZ' } });
    const resource = await prisma.resource.create({ data: { projectId: other.id, name: 'Other resource', category: 'mineral' } });
    const tradeRoute = await prisma.tradeRoute.create({ data: { projectId: other.id, name: 'Other route' } });
    const snapshot = await prisma.worldSnapshot.create({ data: { projectId: other.id, name: 'Other snapshot', state: {} } });
    const paths = ['/economy/currencies/' + currency.id, '/economy/resources/' + resource.id,
      '/economy/trade-routes/' + tradeRoute.id, '/snapshots/' + snapshot.id];
    for (const path of paths) assert.equal((await request('DELETE', path)).statusCode, 404);
    assert.ok(await prisma.currency.findUnique({ where: { id: currency.id } }));
    assert.ok(await prisma.resource.findUnique({ where: { id: resource.id } }));
    assert.ok(await prisma.tradeRoute.findUnique({ where: { id: tradeRoute.id } }));
    assert.ok(await prisma.worldSnapshot.findUnique({ where: { id: snapshot.id } }));
  } finally {
    await app.close();
    await prisma.$disconnect();
  }
});
