import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bookOfferOf, bookOfferSchema } from './bookOffer.js';

const offer = { regular: 20000, discounted: 15000, currency: 'RUB' as const, expiresAt: '2027-01-01T00:00:00Z', href: 'https://example.com/book' };

test('shows an active discount and gives the owner access to expired data', () => {
  assert.deepEqual(bookOfferOf({ bookOffer: offer }, false, 0), offer);
  assert.equal(bookOfferOf({ bookOffer: offer }, false, Date.parse(offer.expiresAt)), null);
  assert.deepEqual(bookOfferOf({ bookOffer: offer }, true, Date.parse(offer.expiresAt)), offer);
});

test('rejects non-discounts, malformed data and unsafe links', () => {
  assert.equal(bookOfferSchema.safeParse({ ...offer, discounted: offer.regular }).success, false);
  for (const href of ['not a link', 'javascript:alert(1)', 'http://example.com', 'https://secret@example.com']) {
    assert.equal(bookOfferSchema.safeParse({ ...offer, href }).success, false);
  }
  assert.equal(bookOfferOf({ unrelated: true }), null);
});
