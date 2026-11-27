import assert from 'node:assert/strict';
import { test } from 'node:test';
import { browserSource, writeNeedsBrowserOrigin } from './browserWritePolicy.js';

test('проверка источника охватывает запись в API и сохраняет подписанный платёжный callback', () => {
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    assert.equal(writeNeedsBrowserOrigin(method, '/api/me/settings?mode=test'), true);
  }
  assert.equal(writeNeedsBrowserOrigin('GET', '/api/me/settings'), false);
  assert.equal(writeNeedsBrowserOrigin('OPTIONS', '/api/me/settings'), false);
  assert.equal(writeNeedsBrowserOrigin('POST', '/api/payments/nowpayments/webhook'), false);
  assert.equal(writeNeedsBrowserOrigin('POST', '/api/payments/nowpayments/webhook/other'), true);
});

test('источником является точный Origin либо проверяемый Referer', () => {
  const source = 'https://openwritter.example';
  assert.equal(browserSource({ origin: source }), source);
  assert.equal(browserSource({ referer: source + '/account' }), source);
  assert.equal(browserSource({ origin: 'null', referer: source }), null);
  assert.equal(browserSource({ origin: [source], referer: source }), null);
  assert.equal(browserSource({ origin: source + '/account' }), null);
  assert.equal(browserSource({}), null);
});
