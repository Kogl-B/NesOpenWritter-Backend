import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCbrRates } from './cbrRates.js';
import { CURRENCIES, paymentQuote } from './paymentCurrency.js';

test('Банк России отдаёт курс с номиналом и запятой', () => {
  const xml = `<?xml version="1.0" encoding="windows-1251"?>
    <ValCurs Date="27.11.2026" name="Foreign Currency Market">
      <Valute ID="BYN"><CharCode>BYN</CharCode><Nominal>10</Nominal><Value>273,199</Value></Valute>
      <Valute ID="USD"><CharCode>USD</CharCode><Nominal>1</Nominal><Value>82,1265</Value></Valute>
    </ValCurs>`;
  assert.deepEqual(parseCbrRates(xml), { date: '2026-11-27',
    BYN: { nominal: 10, rubles: 273.199 }, USD: { nominal: 1, rubles: 82.1265 } });
  assert.equal(parseCbrRates(xml.replace('82,1265', '0')), null);
  assert.equal(parseCbrRates('<html>Unavailable</html>'), null);
  assert.equal(parseCbrRates(xml.replace('27.11.2026', '2026-11-27')), null);
});

test('шесть пар сохраняют стоимость при круговых обменах', () => {
  const weights = { BYN: 1, USD: 3.0061, RUB: 0.036581 };
  const [BYN, RUB, USD] = CURRENCIES;
  const quote = (from: typeof BYN | typeof RUB | typeof USD, to: typeof from, cents: number) =>
    paymentQuote(from, to, cents, weights, 'NBRB', '2026-11-27', 'down')!;
  for (const from of CURRENCIES) {
    for (const next of CURRENCIES.filter(code => code !== from)) {
      const third = CURRENCIES.find(code => code !== from && code !== next)!;
      for (let amount = 1; amount < 2000; amount++) {
        const step = quote(from, next, amount);
        assert.ok(quote(next, from, step.outputCents).outputCents <= amount);
        const middle = quote(next, third, step.outputCents);
        assert.ok(quote(third, from, middle.outputCents).outputCents <= amount);
      }
    }
  }
  const q = quote('BYN', 'RUB', 1000);
  assert.equal(q.outputCents, 27336);
  assert.notEqual(q.id, quote('BYN', 'RUB', 1001).id);
  assert.equal(paymentQuote('BYN', 'USD', 1000, { BYN: 1 }, 'NBRB', null, 'down'), null);
});

test('счёт в USD округляется до цента по выбранному источнику', () => {
  const byn = paymentQuote('BYN', 'USD', 1500, { BYN: 1, USD: 3.0061 }, 'NBRB', '2026-11-27', 'nearest')!;
  const rub = paymentQuote('RUB', 'USD', 50_000, { RUB: 1, USD: 82.1265 }, 'CBR', '2026-11-27', 'nearest')!;
  assert.deepEqual([byn.outputCents, rub.outputCents], [499, 609]);
});
