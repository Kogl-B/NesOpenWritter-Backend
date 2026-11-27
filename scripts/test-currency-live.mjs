import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { prisma } from '../dist/lib/prisma.js';
import { nowpaymentsSignature } from '../dist/lib/nowpayments.js';

const server = new URL(process.env.FINANCE_TEST_ORIGIN ?? 'http://127.0.0.1:5182');
assert.ok(['localhost', '127.0.0.1'].includes(server.hostname));
assert.match(new URL(process.env.DATABASE_URL).pathname, /(?:^|_)(?:qa|demo|test)(?:_|$)/i);
const headers = { origin: server.origin, 'user-agent': 'Mozilla/5.0 OpenWritter QA' };
let cookie;

async function call(path, method = 'GET', data, status = 200, extraHeaders = {}) {
  const response = await fetch(new URL(path, server), { method, headers: {
    ...headers, ...extraHeaders, ...(cookie && { cookie }), ...(data && { 'content-type': 'application/json' }),
  }, body: data && JSON.stringify(data) });
  const result = await response.json();
  assert.equal(response.status, status, `${method} ${path} ${result.error ?? ''}`);
  return { result, cookies: response.headers.getSetCookie() };
}
try {
  const { result: signup, cookies } = await call('/api/auth/sign-up/email', 'POST', {
    email: `currency-qa-${randomUUID()}@example.com`, name: 'Currency QA', password: randomUUID(),
  });
  cookie = cookies.map(data => data.split(';')[0]).join('; ');
  const id = signup.user.id;
  assert.ok(cookie);
  const currencies = ['BYN', 'RUB', 'USD'];
  const { result: { banks, paymentCurrencies } } = await call('/api/currency/rates');
  assert.ok(banks.NBRB.available && banks.CBR.available, JSON.stringify(banks));
  assert.equal(paymentCurrencies.nowpayments, 'USD');
  assert.deepEqual(paymentCurrencies.wallet, currencies);
  console.log('Официальные курсы', JSON.stringify(banks));

  await prisma.user.update({ where: { id }, data: {
    walletBalanceCents: 100_000n, rubBalanceCents: 100_000n, aiBalanceCents: 100_000,
  } });
  const balances = async () => (await call('/api/me/wallet/balances')).result.balances;
  for (const from of currencies) {
    for (const to of currencies.filter(currency => currency !== from)) {
      const amountCents = 1000;
      const query = new URLSearchParams({ from, to, amountCents });
      const before = await balances();
      const { result: { quote } } = await call('/api/me/wallet/quote?' + query);
      assert.equal(quote.source, 'NBRB');
      assert.equal(quote.outputCents, Math.floor(amountCents *
        (banks.NBRB.rates[from] ?? 1) / (banks.NBRB.rates[to] ?? 1)));
      const transfer = { from, to, amountCents, requestId: randomUUID(), quoteId: quote.id };
      await call('/api/me/wallet/transfer', 'POST', { ...transfer, quoteId: 'expired' }, 409);
      assert.deepEqual(await balances(), before);
      const [one, duplicate] = await Promise.all([call('/api/me/wallet/transfer', 'POST', transfer), call('/api/me/wallet/transfer', 'POST', transfer)]);
      assert.equal(one.result.paymentId, duplicate.result.paymentId);
      const target = { ...before, [from]: before[from] - amountCents, [to]: before[to] + quote.outputCents };
      assert.deepEqual(await balances(), target);
      const saved = await prisma.walletOperation.findUniqueOrThrow({ where: { userId_requestId: { userId: id, requestId: transfer.requestId } } });
      assert.deepEqual([saved.fromCurrency, saved.toCurrency, saved.exchangeQuote.id], [from, to, quote.id]);
      await call('/api/me/wallet/transfer', 'POST', { ...transfer, to: currencies.find(code => code !== from && code !== to) }, 409);
      console.log('OK обмен', from, to, amountCents, quote.outputCents);
    }
  }

  const syntheticSecret = process.env.NOWPAYMENTS_IPN_SECRET;
  assert.ok(syntheticSecret, 'Нужен ключ уведомлений тестового провайдера');
  const status = (await call('/api/payments/crypto/status')).result;
  assert.equal(status.sandbox, true, 'Разрешены только тестовые счета');
  for (const [currency, amountCents, source] of [['BYN', 2500, 'NBRB'], ['RUB', 100_000, 'CBR'], ['USD', 500, 'USD']]) {
    const input = { currency, amountCents };
    const { result: { quote, withinLimits } } = await call('/api/payments/crypto/invoice-quote?' + new URLSearchParams(input));
    assert.equal(quote.source, source);
    assert.equal(quote.to, 'USD');
    assert.ok(withinLimits);
    await call('/api/payments/crypto/invoices', 'POST', { ...input, quoteId: 'expired' }, 409);
    const { result } = await call('/api/payments/crypto/invoices', 'POST', { ...input, quoteId: quote.id }, 201);
    const saved = await prisma.cryptoPayment.findUniqueOrThrow({ where: { id: result.orderId } });
    assert.equal(result.currency, 'USD');
    assert.equal(saved.amountUsdCents, quote.outputCents);
    assert.equal(saved.priceQuote.id, quote.id);
    assert.ok(saved.providerId);
    const before = await balances();
    const notice = { order_id: result.orderId, payment_status: 'finished' };
    const sign = nowpaymentsSignature(notice, syntheticSecret);
    await Promise.all([1, 2].map(() => call('/api/payments/nowpayments/webhook', 'POST', notice, 200, { 'x-nowpayments-sig': sign })));
    assert.deepEqual(await balances(), { ...before, USD: before.USD + saved.amountUsdCents });
    console.log('OK NOWPayments', currency, source, 'USD cents', saved.amountUsdCents);
  }
} finally {
  await prisma.$disconnect();
}
