import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import { prisma } from '../dist/lib/prisma.js';
import { nowpaymentsSignature } from '../dist/lib/nowpayments.js';

const base = new URL(process.env.FINANCE_TEST_ORIGIN ?? 'http://127.0.0.1:5182');
const dbName = new URL(process.env.DATABASE_URL).pathname.slice(1);
assert.ok(['localhost', '127.0.0.1'].includes(base.hostname));
assert.match(dbName, /(?:^|_)(?:qa|demo|test)(?:_|$)/i, 'Нужна отдельная тестовая база');
const secret = process.env.NOWPAYMENTS_IPN_SECRET;
assert.ok(secret, 'Нужен ключ уведомлений тестового провайдера');

async function call(http, path, method = 'GET', data, expected = 200, extraHeaders = {}, retrySignup = true) {
  const headers = { origin: base.origin, 'user-agent': 'Mozilla/5.0 OpenWritter QA', ...extraHeaders };
  if (http.cookie) headers.cookie = http.cookie;
  if (data) headers['content-type'] = 'application/json';
  const response = await fetch(new URL(path, base), { method, headers, body: data && JSON.stringify(data) });
  const json = await response.json();
  if (retrySignup && response.status === 429 && path === '/api/auth/sign-up/email') {
    const retryAfter = Number(response.headers.get('retry-after')) || 10;
    assert.ok(retryAfter > 0 && retryAfter <= 30, 'Слишком долго ждать лимит регистрации');
    await setTimeout((retryAfter + 1) * 1000);
    return call(http, path, method, data, expected, extraHeaders, false);
  }
  assert.equal(response.status, expected, `${method} ${path} ${json.error ?? ''}`);
  return { json, cookie: response.headers.getSetCookie().map(cookie => cookie.split(';')[0]).join('; ') };
}

async function user() {
  const { json, cookie } = await call({}, '/api/auth/sign-up/email', 'POST', {
    name: 'Finance regression QA', email: `finance-qa-${randomUUID()}@example.com`, password: randomUUID(),
  });
  return { id: json.user.id, cookie };
}
const balances = id => prisma.user.findUniqueOrThrow({
  where: { id }, select: { walletBalanceCents: true, aiBalanceCents: true },
});
const payment = (amountCents, requestId = randomUUID()) => ({ amountCents, requestId });
const activate = (who, offer, expected) => call(who, '/api/account/plan', 'PATCH', { plan: 'pro', payment: offer }, expected);
const exchange = (who, data, status = 200) => call(who, '/api/me/wallet/transfer', 'POST', data, status);
const balance = async who => (await balances(who.id)).aiBalanceCents;
const invoiceState = id => prisma.cryptoPayment.findUniqueOrThrow({ where: { id } });

async function notice(order_id, payment_status, more, expected = 200, sign = true) {
  const data = { order_id, payment_status, ...more };
  return call({}, '/api/payments/nowpayments/webhook', 'POST', data, expected, {
    'x-nowpayments-sig': sign ? nowpaymentsSignature(data, secret) : '0'.repeat(128),
  });
}

// OpenWritter обрабатывает подписанные уведомления с обычными записями счёта без внешнего платежа.
const invoice = async who => (await prisma.cryptoPayment.create({
  data: { userId: who.id, amountUsdCents: 500, purpose: 'ai_balance' },
})).id;

try {
  const [reader, author, payer, operator] = await Promise.all([user(), user(), user(), user()]);
  await prisma.user.update({ where: { id: operator.id }, data: { accountStatus: 'admin' } });
  const ad = 'qa-finance-' + randomUUID();
  await prisma.houseAd.create({ data: { id: ad, title: 'QA', body: 'QA', href: '/' } });
  const ads = async () => (await call(reader, '/api/ads/' + ad)).json.ad;
  assert.ok(await ads());
  await activate(reader, undefined, 402);
  await activate(reader, payment(3000), 402);
  await prisma.user.update({ where: { id: reader.id }, data: { plan: 'pro', walletBalanceCents: 9000n } });
  assert.equal((await call(reader, '/api/account/usage')).json.plan, 'test');
  assert.ok(await ads());
  await activate(reader, payment(1), 409);
  const offer = payment(3000);
  const orders = await Promise.all([activate(reader, offer, 200), activate(reader, offer, 200)]);
  assert.equal(orders[0].json.paymentId, orders[1].json.paymentId);
  assert.equal(orders[0].json.projects.limit, 75);
  assert.ok(Date.parse(orders[0].json.expiresAt) > Date.now());
  assert.equal((await balances(reader.id)).walletBalanceCents, 6000n);
  assert.equal(await ads(), null);
  await activate(reader, payment(3000), 409);
  await prisma.walletOperation.update({ where: { userId_requestId: { userId: reader.id, requestId: offer.requestId } },
    data: { expiresAt: new Date(Date.now() - 1000) } });
  assert.equal((await call(reader, '/api/account/usage')).json.plan, 'test');
  assert.ok(await ads());
  await prisma.houseAd.delete({ where: { id: ad } });
  console.log('OK сервисный тариф: проверка остатка, одна квитанция, срок действия, реклама');

  const exchangeData = { direction: 'to-ai', amount: 3.5, requestId: randomUUID() };
  assert.equal((await exchange(reader, { ...exchangeData, amount: 0.02 }, 400)).json.error.length > 0, true);
  const exchanges = await Promise.all([exchange(reader, exchangeData), exchange(reader, exchangeData)]);
  assert.equal(exchanges[0].json.paymentId, exchanges[1].json.paymentId);
  assert.equal((await balances(reader.id)).walletBalanceCents, 5650n);
  await exchange(reader, { ...exchangeData, amount: 4 }, 409);
  console.log('OK обмен: повтор идемпотентен, квитанция одна, конфликт суммы отклонён');

  const { json: { level } } = await call(author, '/api/me/blog/levels', 'POST', { title: 'QA access', priceRub: 300 }, 201);
  const body = 'Тестовый короткий платный пост.';
  const { json: { post } } = await call(author, '/api/me/blog', 'POST', {
    title: 'QA paid post', body, published: true, audience: 'level', levelId: level.id,
  }, 201);
  const path = '/api/blog/' + post.id;
  const publicPost = (await call({}, path)).json.post;
  assert.deepEqual([publicPost.locked, publicPost.body, publicPost.excerpt], [true, '', '']);
  const subscription = '/api/blog/authors/' + author.id;
  const { json: { quote } } = await call(reader, subscription + '/subscription-quote?levelId=' + level.id);
  await call(reader, subscription + '/subscribe', 'POST', { levelId: level.id, payment: { ...quote, requestId: randomUUID() } });
  assert.ok((await call(reader, path)).json.post.body.includes(body));
  const donation = { amountCents: 500, requestId: randomUUID() };
  await Promise.all([call(reader, path + '/donate', 'POST', donation, 201), call(reader, path + '/donate', 'POST', donation, 201)]);
  const earned = (await call(author, '/api/me/blog/earnings?days=0')).json;
  assert.deepEqual([earned.balanceCents, earned.totalSubscriptionCents, earned.totalDonationCents], [quote.amountCents + 500, quote.amountCents, 500]);
  console.log('OK блог: закрытый текст, авторская подписка, повтор доната и сверка дохода');

  const first = await invoice(payer);
  await notice(first, 'finished', {}, 403, false);
  await notice(first, 'partially_paid', { actually_paid: 0, pay_amount: 1 });
  await notice(first, 'partially_paid', { actually_paid: 0.5, pay_amount: 1 });
  assert.equal(await balance(payer), 250);
  await notice(first, 'partially_paid', { actually_paid: 0.2, pay_amount: 1 });
  await Promise.all([notice(first, 'finished'), notice(first, 'finished')]);
  assert.equal(await balance(payer), 500);
  assert.equal((await invoiceState(first)).status, 'finished');
  await Promise.all([notice(first, 'refunded'), notice(first, 'refunded')]);
  assert.equal(await balance(payer), 0);

  const ordered = await invoice(payer);
  const updates = [];
  async function waitForBlocked(minimum) {
    for (let attempt = 0; attempt < 35; attempt++) {
      const [{ count }] = await prisma.$queryRaw`SELECT count(*)::int FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE '%crypto_payments%'`;
      if (count >= minimum) return;
      await setTimeout(100);
    }
    throw Error('Не удалось воспроизвести одновременно пришедшие уведомления');
  }
  try {
    await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM crypto_payments WHERE id = ${ordered} FOR UPDATE`;
      updates.push(notice(ordered, 'finished'));
      await waitForBlocked(1);
      updates.push(notice(ordered, 'refunded'));
      await waitForBlocked(2);
    }, { timeout: 15000 });
  } finally {
    await Promise.all(updates);
  }
  assert.equal((await invoiceState(ordered)).status, 'refunded');
  assert.equal(await balance(payer), 0);
  await notice(ordered, 'finished');
  assert.equal(await balance(payer), 0);
  console.log('OK крипто: частичная и полная оплата, повторы, возврат во время зачисления');

  const converted = await invoice(payer);
  await notice(converted, 'finished');
  await exchange(payer, { direction: 'to-wallet', amount: 5, requestId: randomUUID() });
  await Promise.all([notice(converted, 'refunded'), notice(converted, 'refunded')]);
  assert.equal(await balance(payer), -500);
  await call(payer, path + '/donate', 'POST', { ...donation, requestId: randomUUID() }, 409);
  await call(payer, subscription + '/subscribe', 'POST', { levelId: level.id, payment: { ...quote, requestId: randomUUID() } }, 409);
  await activate(payer, payment(3000), 409);
  assert.equal(await prisma.notification.count({ where: { userId: operator.id, eventKey: `finance-refund-debt:${converted}` } }), 1);
  const alerts = (await call(operator, '/api/notifications?kind=admin_message')).json.notices;
  assert.ok(alerts.some(row => row.kind === 'admin_message' && row.body.includes(converted)));
  assert.equal(await prisma.notification.count({ where: { userId: operator.id, eventKey: `finance-refund-debt:${ordered}` } }), 0);
  const repayment = await invoice(payer);
  await notice(repayment, 'finished');
  assert.equal(await balance(payer), 0);
  await call(payer, path + '/donate', 'POST', { ...donation, requestId: randomUUID() }, 201);
  console.log('OK долг: уведомление оператору один раз, запрет платежей и восстановление после погашения');
} finally {
  await prisma.$disconnect();
}
