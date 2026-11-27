import assert from 'node:assert/strict';
import { test } from 'node:test';
import { exchangeCents } from './walletExchange.js';

test('обмен в обе стороны не создаёт деньги за счёт округления', () => {
  assert.equal(exchangeCents('to-ai', 2, 30061), 0);
  assert.equal(exchangeCents('to-wallet', 1, 30061), 3);
  for (const rateUnits of [2345, 9999, 10_001, 30_061, 87_530]) {
    for (let cents = 1; cents <= 2000; cents++) {
      assert.ok(exchangeCents('to-wallet', exchangeCents('to-ai', cents, rateUnits), rateUnits) <= cents);
      assert.ok(exchangeCents('to-ai', exchangeCents('to-wallet', cents, rateUnits), rateUnits) <= cents);
    }
  }
});
