import assert from 'node:assert/strict';
import { it } from 'node:test';
import { suggestionDayMs, suggestionStatus } from './blogSuggestionPolicy.js';

const latest = new Date('2026-11-28T10:00:00Z');
const after = (ms: number) => new Date(latest.getTime() + ms);

it('allows the first suggestion and enforces each boundary before the next one', () => {
  assert.equal(suggestionStatus(latest, { count: 0, latest: undefined }, null).stage, 'available');
  for (const [count, minutes] of [[1, 5], [4, 5], [5, 10], [9, 10], [10, 15], [49, 15]] as const) {
    const delay = minutes * 60_000;
    assert.deepEqual(suggestionStatus(after(delay - 1), { count, latest }, null), {
      stage: 'cooldown', retryAt: after(delay).toISOString(), requested: false,
    });
    assert.equal(suggestionStatus(after(delay), { count, latest }, null).stage, 'available');
  }
});

it('keeps the full block even after old suggestions age out, and exposes a pending request once', () => {
  const blockedUntil = after(suggestionDayMs);
  assert.equal(suggestionStatus(latest, { count: 50, latest }, null).retryAt, blockedUntil.toISOString());
  const limit = { blockedUntil, requestedAt: after(60_000) };
  assert.deepEqual(suggestionStatus(after(suggestionDayMs - 1), { count: 2, latest }, limit), {
    stage: 'blocked', retryAt: blockedUntil.toISOString(), requested: true,
  });
  assert.deepEqual(suggestionStatus(blockedUntil, { count: 0, latest: undefined }, limit), {
    stage: 'available', retryAt: null, requested: false,
  });
});
