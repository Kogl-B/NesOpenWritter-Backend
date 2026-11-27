import assert from 'node:assert/strict';
import { test } from 'node:test';

const origin = 'http://localhost:8098';
const email = 'ad-qa@example.invalid';
const publisherId = 'pub-0000000000000000';
const fakeCmp = '00000000-0000-4000-8000-000000000001';
const fields = ['DATE','AD_UNIT_ID','AD_REQUESTS','MATCHED_AD_REQUESTS','IMPRESSIONS','CLICKS','ESTIMATED_EARNINGS','ACTIVE_VIEW_MEASURABILITY','ACTIVE_VIEW_VIEWABILITY'];
const day = new Date(Date.now() - 24 * 3600_000).toISOString().slice(0, 10);

test('advertising delivery, accounting and AdSense replacement in PostgreSQL', async (t) => {
  const url = process.env.ADS_TEST_DATABASE_URL;
  assert.ok(url, 'Set ADS_TEST_DATABASE_URL to an isolated ow_ads_qa_* database');
  assert.match(new URL(url).pathname, /^\/ow_ads_qa_[a-z0-9_]+$/);
  Object.assign(process.env, {
    DATABASE_URL: url, NODE_ENV: 'test', LOG_LEVEL: 'fatal',
    BETTER_AUTH_URL: origin, FRONTEND_URL: origin, CORS_ORIGIN: origin,
    BETTER_AUTH_SECRET: 'ad-test-only-not-a-production-secret',
    REQUIRE_EMAIL_VERIFICATION: 'false', ADMIN_EMAILS: email,
    GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '', RESEND_API_KEY: '', SENTRY_DSN: '',
    ADSENSE_SERVING: 'true', ADSENSE_DOMAIN: 'openwritter.app', ADSENSE_SYNC: 'false',
    ADSENSE_CLIENT_ID: 'test-client', ADSENSE_CLIENT_SECRET: 'test-secret', ADSENSE_REFRESH_TOKEN: 'test-refresh',
  });
  const { buildApp } = await import('../app.js');
  const { prisma } = await import('../lib/prisma.js');
  const realFetch = globalThis.fetch;
  let count = '6';
  let expectedRows = '1';
  let googleCalls = 0;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === 'oauth2.googleapis.com') {
      return Response.json({ access_token: 'simulated' });
    }
    if (url.hostname === 'adsense.googleapis.com') {
      googleCalls++;
      assert.equal(url.pathname, '/v2/accounts/' + publisherId + '/reports:generate');
      assert.equal(url.searchParams.get('filters'), 'DOMAIN_NAME==openwritter.app');
      assert.equal(url.searchParams.get('reportingTimeZone'), 'GOOGLE_TIME_ZONE');
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer simulated');
      return Response.json({ totalMatchedRows: expectedRows,
        headers: fields.map(name => ({ name, currencyCode: name === 'ESTIMATED_EARNINGS' ? 'USD' : undefined })),
        rows: [{ cells: [day, 'ca-' + publisherId + ':123', '9', '7', count, '1', '0.018', '0.75', '0.6'].map(value => ({ value })) }],
      });
    }
    return realFetch(input, init);
  };
  const app = await buildApp();
  try {
    const register = async (address: string) => {
      const response = await app.inject({
        method: 'POST', url: '/api/auth/sign-up/email', headers: { origin, host: 'localhost:8098' },
        payload: { email: address, password: 'QA-Advertising-Only123!', name: 'QA' },
      });
      assert.equal(response.statusCode, 200);
      const user = await prisma.user.update({ where: { email: address }, data: { emailVerified: true, ...(address === email ? { accountStatus: 'admin' } : { plan: 'hobby' }) } });
      if (address !== email) {
        await prisma.walletOperation.create({ data: {
          userId: user.id, requestId: 'ads-qa-service-plan', kind: 'service-plan', plan: 'hobby',
          sourceCents: 1000, receivedCents: 0, expiresAt: new Date(Date.now() + 3600_000),
        } });
      }
      return response.cookies.map(({ name, value }) => name + '=' + value).join('; ');
    };
    const cookie = await register(email);
    const paidUser = await register('reader-qa@example.invalid');
    const postEndpoint = '/api/admin/advertising/posts';
    const settingsEndpoint = '/api/admin/advertising/settings';
    const placement = '/api/advertising/placement/site-banner';
    const report = '/api/admin/advertising/report?from=' + day + '&to=' + day;
    const admin = { origin, cookie };
    const now = new Date();
    const campaign = {
      title: 'Платная публикация QA', summary: 'Короткий текст', body: 'Текст объявления',
      advertiser: 'Компания QA', registrationId: 'QA-123', href: 'https://example.com/', imageUrl: '',
      placement: 'site-banner', state: 'active', priceMinor: 15000, currency: 'RUB', paid: false,
      startsAt: new Date(now.getTime() - 10000).toISOString(), endsAt: new Date(now.getTime() + 3600_000).toISOString(),
    };

    await t.test('the site banner follows the expiry date of the service subscription', async () => {
      const user = await prisma.user.findUniqueOrThrow({ where: { email: 'reader-qa@example.invalid' } });
      const where = { userId_requestId: { userId: user.id, requestId: 'ads-qa-service-plan' } };
      const load = () => app.inject({ method: 'GET', url: placement, headers: { cookie: paidUser } });
      assert.equal((await load()).json().ad, null);
      await prisma.walletOperation.update({ where, data: { expiresAt: new Date(Date.now() - 3600_000) } });
      try {
        assert.equal((await load()).json().ad?.kind, 'house');
      } finally {
        await prisma.walletOperation.update({ where, data: { expiresAt: new Date(Date.now() + 3600_000) } });
      }
      assert.equal((await load()).json().ad, null);
    });

    await t.test('admin gates, default house delivery, scheduled paid publication and accounting', async () => {
      assert.equal((await app.inject({ method: 'GET', url: '/api/admin/advertising' })).statusCode, 401);
      assert.equal((await app.inject({ method: 'GET', url: '/api/admin/advertising', headers: { cookie: paidUser } })).statusCode, 403);
      assert.equal((await app.inject(placement)).json().ad.kind, 'house');
      const paidPlacement = await app.inject({ method: 'GET', url: placement, headers: { cookie: paidUser } });
      assert.equal(paidPlacement.json().ad, null);
      const created = await app.inject({ method: 'POST', url: postEndpoint, headers: admin, payload: campaign });
      assert.equal(created.statusCode, 201);
      const post = created.json().post;
      assert.equal((await app.inject('/api/advertising/posts/' + post.id)).statusCode, 404);
      assert.equal((await app.inject(placement)).json().ad.kind, 'house');
      const updateUrl = postEndpoint + '/' + post.id;
      assert.equal((await app.inject({ method: 'PUT', url: updateUrl, headers: admin, payload: { ...campaign, paid: true, revision: post.updatedAt } })).statusCode, 200);
      assert.equal((await app.inject({ method: 'PUT', url: updateUrl, headers: admin, payload: { ...campaign, revision: post.updatedAt } })).statusCode, 409);
      const conflict = await app.inject({ method: 'POST', url: postEndpoint, headers: admin,
        payload: { ...campaign, title: 'Overlapping paid campaign', paid: true } });
      assert.equal(conflict.statusCode, 409);
      const delivery = await app.inject(placement);
      assert.equal(delivery.json().ad.kind, 'manual');
      assert.equal(delivery.json().ad.registrationId, 'QA-123');
      assert.equal(delivery.json().ad.priceMinor, undefined);
      const token = delivery.json().ad.token;
      const eventUrl = '/api/advertising/event';
      const send = (type: string, value = token) => app.inject({ method: 'POST', url: eventUrl, headers: { origin }, payload: { token: value, type } });
      assert.equal((await app.inject({ method: 'POST', url: eventUrl, payload: { token, type: 'click' } })).statusCode, 403);
      const invalid = token.split('.')[0] + '.' + 'A'.repeat(43);
      assert.equal((await send('click', invalid)).statusCode, 400);
      for (const response of await Promise.all(['click','viewable','impression','click','viewable'].map(type => send(type)))) {
        assert.equal(response.statusCode, 204);
      }
      const page = await app.inject('/api/advertising/posts/' + post.id);
      assert.equal(page.statusCode, 200);
      assert.equal(page.json().post.body, campaign.body);
      assert.equal((await send('click', page.json().post.token)).statusCode, 204);
      const all = await prisma.adExposure.findMany({ where: { postId: post.id }, orderBy: { placement: 'desc' } });
      assert.deepEqual(all.map(row => [row.placement, row.viewable, row.clicked]), [['site-banner',true,true],['post',false,true]]);
    });

    await t.test('publisher ads.txt, guest-only Google configuration and atomic report import', async () => {
      assert.equal((await app.inject('/ads.txt')).statusCode, 404);
      const values = { publisherId, cookiebotId: fakeCmp, siteUnit: '', readerUnit: '123', enabled: true };
      assert.equal((await app.inject({ method: 'PUT', url: settingsEndpoint, headers: admin, payload: values })).statusCode, 200);
      assert.match((await app.inject('/ads.txt')).body, new RegExp(publisherId));
      const reader = '/api/advertising/placement/reader-note';
      assert.equal((await app.inject(reader)).json().ad.kind, 'house');
      const google = await app.inject({ method: 'GET', url: reader, headers: { 'x-ow-public-origin': 'https://openwritter.app' } });
      assert.deepEqual(google.json().ad, { kind: 'google', client: 'ca-' + publisherId, unit: '123', cmpId: fakeCmp });
      const paid = await app.inject({ method: 'GET', url: reader, headers: { cookie: paidUser, 'x-ow-public-origin': 'https://openwritter.app' } });
      assert.equal(paid.json().ad, null);
      const importReport = () => app.inject({ method: 'POST', url: '/api/admin/advertising/adsense/sync', headers: admin, payload: { from: day, to: day } });
      assert.equal((await importReport()).statusCode, 200);
      const read = async () => (await app.inject({ method: 'GET', url: report, headers: admin })).json().google[0];
      assert.equal((await read()).impressions, '6');
      expectedRows = '2';
      assert.equal((await importReport()).statusCode, 502);
      assert.equal((await read()).impressions, '6', 'a truncated response preserves the last complete report');
      expectedRows = '1';
      count = '7';
      assert.equal((await importReport()).statusCode, 200);
      assert.equal((await read()).impressions, '7');
      assert.equal((await read()).viewability, '0.6');
      assert.equal(googleCalls, 3);
    });
  } finally {
    globalThis.fetch = realFetch;
    await app.close();
    await prisma.$disconnect();
  }
});
