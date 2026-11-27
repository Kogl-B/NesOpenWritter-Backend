import assert from 'node:assert/strict';
import { test } from 'node:test';

test('оба банка обновляются без запросов пользователей в 00:00, 06:00, 12:00 и 18:00 по Минску', async t => {
  const hour = 60 * 60 * 1000;
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: new Date('2026-11-26T20:59:00Z') });
  const calls = { nbrb: 0, cbr: 0 };

  t.mock.method(globalThis, 'fetch', async (input: URL | string) => {
    const url = new URL(input);
    const date = new Date(Date.now() + 3 * hour).toISOString().slice(0, 10);
    if (url.hostname === 'api.nbrb.by') {
      calls.nbrb++;
      return Response.json([
        { Cur_Abbreviation: 'USD', Cur_Scale: 1, Cur_OfficialRate: calls.nbrb + 2, Date: date },
        { Cur_Abbreviation: 'RUB', Cur_Scale: 100, Cur_OfficialRate: 4, Date: date },
      ]);
    }
    assert.equal(url.hostname, 'www.cbr.ru');
    calls.cbr++;
    const day = date.split('-').reverse();
    assert.equal(url.searchParams.get('date_req'), day.join('/'));
    return new Response(`<ValCurs Date="${day.join('.')}">
      <Valute><CharCode>BYN</CharCode><Nominal>1</Nominal><Value>27,30</Value></Valute>
      <Valute><CharCode>USD</CharCode><Nominal>1</Nominal><Value>${80 + calls.cbr},12</Value></Valute>
    </ValCurs>`);
  });

  const { getRates } = await import('./currency.js');
  const { getCbrRates } = await import('./cbrRates.js');

  const [before, beforeCbr] = await Promise.all([getRates(), getCbrRates()]);
  assert.equal(before.USD.updatedAt, '2026-11-26');
  assert.equal(beforeCbr?.date, '2026-11-26');

  for (let slot = 0; slot < 4; slot++) {
    const next = slot === 0 ? 60_000 : 6 * hour;
    t.mock.timers.tick(next - 1);
    assert.deepEqual(calls, { nbrb: slot + 1, cbr: slot + 1 });
    t.mock.timers.tick(1);
    assert.deepEqual(calls, { nbrb: slot + 2, cbr: slot + 2 });
    const [[rate, cbr]] = await Promise.all([
      Promise.all([getRates(), getCbrRates()]),
      Promise.all([getRates(), getCbrRates()]),
    ]);
    assert.equal(rate.USD.rate, slot + 4);
    assert.equal(cbr?.USD.rubles, 82.12 + slot);
    assert.deepEqual(calls, { nbrb: slot + 2, cbr: slot + 2 });
  }
});
