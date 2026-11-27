import assert from 'node:assert/strict';
import { test } from 'node:test';
import { completeSchema, continuityReserveCents } from './completeWork.js';
import { continuityHold } from './continuityWallet.js';

const prices = {
  inputMissUsdPerM: 150_000, inputHitUsdPerM: 3_000, outputUsdPerM: 600_000,
  peakMultiplier: 2, chargeMultiplier: 3,
};
const basics = {
  purpose: 'continuity-check', continuityMode: 'basic', projectId: 'book', context: 'Герой видел ключ.',
};

test('reserves more for world context and longer manuscripts under the worst effective price', () => {
  const text = continuityReserveCents(completeSchema.parse(basics), prices);
  assert.ok(text > 0);
  assert.ok(continuityReserveCents(completeSchema.parse({ ...basics, continuityMode: 'world' }), prices) > text);
  assert.ok(continuityReserveCents(completeSchema.parse({ ...basics, context: basics.context.repeat(700) }), prices) > text);
  assert.ok(continuityReserveCents(completeSchema.parse(basics), {
    ...prices, inputHitUsdPerM: prices.inputMissUsdPerM * 5,
  }) > text);
});

test('recognizes only server reservation data and preserves zero-priced or quota-only holds', () => {
  assert.equal(continuityHold({ billing: { reservedCents: 100 }, usage: { totalTokens: 1 } }), undefined);
  assert.equal(continuityHold({ _continuityHold: { version: 1, cents: -5, wallet: true } }), undefined);
  const zero = { version: 1, cents: 0, wallet: false };
  assert.deepEqual(continuityHold({ _continuityHold: zero }), zero);
});
