import assert from 'node:assert/strict';
import { test } from 'node:test';

const databaseUrl = process.env.STATS_TEST_DATABASE_URL;
const origin = 'http://localhost:8098';
const email = 'metrics-qa@example.invalid';

test('statistics through HTTP and PostgreSQL', async (t) => {
  assert.ok(databaseUrl, 'Set STATS_TEST_DATABASE_URL to a disposable ow_stats_qa_* database');
  assert.match(new URL(databaseUrl).pathname, /^\/ow_stats_qa_[a-z0-9_]+$/);
  Object.assign(process.env, {
    DATABASE_URL: databaseUrl, NODE_ENV: 'test', LOG_LEVEL: 'fatal',
    BETTER_AUTH_URL: origin, FRONTEND_URL: origin, CORS_ORIGIN: origin,
    BETTER_AUTH_SECRET: 'metrics-test-only-not-a-production-secret',
    REQUIRE_EMAIL_VERIFICATION: 'false', ADMIN_EMAILS: email,
    GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '', RESEND_API_KEY: '', SENTRY_DSN: '',
  });
  const { buildApp } = await import('../app.js');
  const { prisma } = await import('../lib/prisma.js');
  const { dayKey, recordOnce } = await import('../lib/traffic.js');
  const app = await buildApp();
  try {
    const signUp = await app.inject({
      method: 'POST', url: '/api/auth/sign-up/email',
      headers: { origin, host: 'localhost:8098' },
      payload: { email, password: 'StatisticsTest123!', name: 'Statistics QA' },
    });
    assert.equal(signUp.statusCode, 200, 'sign up on QA instance');
    const owner = await prisma.user.update({
      where: { email }, data: { accountStatus: 'admin', emailVerified: true },
    });
    const cookie = signUp.cookies.map(({ name, value }) => name + '=' + value).join('; ');
    assert.ok(cookie);
    const project = await prisma.project.create({
      data: { ownerId: owner.id, name: 'Statistics QA', settings: { catalog: { published: true } } },
    });
    const chapter = await prisma.chapter.create({
      data: { projectId: project.id, title: 'Chapter', stage: 'published', charCount: 180 },
    });
    const post = (url: string, payload: Record<string, unknown>, signedIn = false) => app.inject({
      method: 'POST', url, payload, remoteAddress: '192.0.2.21',
      headers: signedIn ? { cookie, origin } : { origin },
    });
    const report = async () => {
      const reply = await app.inject({ method: 'GET', url: '/api/admin/stats', headers: { cookie, origin } });
      assert.equal(reply.statusCode, 200);
      return reply.json().site;
    };
    const daysAgo = (days: number) => dayKey(new Date(Date.now() - days * 86_400_000));

    await t.test('a quick finish and a stale retry preserve the highest percentage', async () => {
      const reportRead = (percent: number, projectId = project.id) =>
        post('/api/metrics/read', { projectId, chapterId: chapter.id, percent }, true);
      for (const percent of [1, 100, 50, 100]) assert.equal((await reportRead(percent)).statusCode, 200);
      const rows = await prisma.readProgress.findMany({ select: { percent: true, charsSeen: true } });
      assert.deepEqual(rows, [{ percent: 100, charsSeen: 180 }]);
      assert.equal((await reportRead(100, 'wrong-project')).statusCode, 404);
      assert.equal((await report()).avgReadPercent, 100);
    });

    await t.test('two browsers behind one IP remain distinct across days and a sign-in', async () => {
      const a = '00000000-0000-4000-8000-000000000001';
      const b = '00000000-0000-4000-8000-000000000002';
      const visit = (browserId: string, area: string, signedIn = false) =>
        post('/api/metrics/visit', { area, browserId, firstToday: true }, signedIn);
      const responses = await Promise.all([visit(a, 'home'), visit(b, 'home')]);
      for (const response of responses) assert.equal(response.statusCode, 204);
      assert.equal((await report()).uniques7, 2, 'distinct browsers sharing an IP');
      assert.equal((await visit(a, 'home', true)).statusCode, 204);
      assert.equal((await report()).uniques7, 2, 'sign-in keeps the browser identity');
      await prisma.$executeRaw`
        INSERT INTO daily_browser_visits (day, "browserHash")
        SELECT ${daysAgo(1)}, "browserHash" FROM daily_browser_visits
        WHERE day = ${daysAgo(0)} LIMIT 1
      `;
      const site = await report();
      assert.equal(site.uniques7, 2, 'same browser on two days is counted once per week');
      assert.deepEqual(site.days.map((d: { uniques: number }) => d.uniques), [1, 2]);
      assert.equal(site.views7, 2, 'sign-in does not change the visit deduplication key');
    });

    await t.test('duplicates wait for the write and a failed write can be retried', async () => {
      let release: () => void = () => {};
      const waiting = new Promise<void>((resolve) => { release = resolve; });
      let writes = 0;
      const fail = async () => {
        writes++;
        await waiting;
        throw new Error('database unavailable');
      };
      const first = recordOnce('qa:failure', 1500, fail);
      const duplicate = recordOnce('qa:failure', 1500, fail);
      release();
      const responses = await Promise.allSettled([first, duplicate]);
      assert.deepEqual(responses.map(({ status }) => status), ['rejected', 'rejected']);
      assert.equal(writes, 1);
      await recordOnce('qa:failure', 1500, async () => { writes++; });
      await recordOnce('qa:failure', 1500, async () => { writes++; });
      assert.equal(writes, 2);
    });

    await t.test('previous clients continue recording views without inventing browser identities', async () => {
      const prior = await report();
      assert.equal((await post('/api/metrics/visit', { area: 'tops', firstToday: true })).statusCode, 204);
      const current = await report();
      assert.equal(current.views7, prior.views7 + 1);
      assert.equal(current.uniques7, prior.uniques7);
      assert.equal((await post('/api/metrics/visit', { area: 'tops', browserId: 'invalid' })).statusCode, 400);
    });

    await t.test('ad totals include days 15–30 without expanding the daily chart', async () => {
      await prisma.houseAd.upsert({ where: { id: 'site-banner' }, update: {}, create: {
        id: 'site-banner', title: 'QA ad', body: 'QA', href: '/account',
      } });
      await prisma.dailyMetric.createMany({ data: [30, 29, 13, 6].flatMap((ago, index) => {
        const day = daysAgo(ago);
        return [
          { day, kind: 'ad_show', bucket: 'site-banner', total: [100, 5, 7, 2][index]! },
          { day, kind: 'ad_click', bucket: 'site-banner', total: [100, 4, 3, 1][index]! },
        ];
      }) });
      const site = await report();
      const ad = site.ads.find((a: { id: string }) => a.id === 'site-banner');
      assert.deepEqual([ad.shows7, ad.clicks7, ad.shows30, ad.clicks30], [2, 1, 14, 8]);
      assert.ok(site.days.some((d: { day: string }) => d.day === daysAgo(13)));
      assert.ok(site.days.every((d: { day: string }) => d.day >= daysAgo(13)));
    });
  } finally {
    await app.close();
    await prisma.$disconnect();
  }
});
