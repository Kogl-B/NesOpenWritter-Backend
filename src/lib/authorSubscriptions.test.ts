import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { authorCharge, nextSubscriptionMonth } from './authorSubscriptions.js';
import { getRates } from './currency.js';

describe('оплата авторской подписки', () => {
  it('продлевает календарный месяц с сохранением времени, включая конец февраля', () => {
    assert.equal(nextSubscriptionMonth(new Date('2028-01-31T10:23:17.000Z')).toISOString(), '2028-02-29T10:23:17.000Z');
    assert.equal(nextSubscriptionMonth(new Date('2026-12-18T06:00:00.000Z')).toISOString(), '2027-01-18T06:00:00.000Z');
  });

  it('округляет ₽ по масштабу курса один раз до копеек BYN', () => {
    const rate = { code: 'RUB', rate: 3.6596, scale: 100, updatedAt: '2026-11-25' };
    assert.equal(authorCharge(150, rate), 549);
    assert.equal(authorCharge(15, { ...rate, scale: 0 }), 0);
  });

  it('после сбоя снова проверяет курс через десять минут в тот же день', async (test) => {
    let now = Date.parse('2026-11-26T10:00:00Z');
    let attempts = 0;
    test.mock.method(Date, 'now', () => now);
    test.mock.method(globalThis, 'fetch', async () => {
      attempts += 1;
      if (attempts === 1) return new Response(null, { status: 503 });
      return Response.json([
        { Cur_Abbreviation: 'USD', Cur_Scale: 1, Cur_OfficialRate: 3, Date: '2026-11-26T00:00:00' },
        { Cur_Abbreviation: 'RUB', Cur_Scale: 100, Cur_OfficialRate: 4, Date: '2026-11-26T00:00:00' },
      ]);
    });
    assert.equal((await getRates()).stale, true);
    now += 60 * 1000;
    assert.equal((await getRates()).stale, true);
    assert.equal(attempts, 1);
    now += 10 * 60 * 1000;
    assert.equal((await getRates()).stale, false);
    assert.equal(attempts, 2);
  });
});
