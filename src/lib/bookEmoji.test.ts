import assert from 'node:assert/strict';
import { test } from 'node:test';
import { allowedBookEmoji, bookEmoji, bookEmojiChoices } from './bookEmoji.js';

test('legacy books get standard reactions and an explicit empty list disables them', () => {
  assert.deepEqual(allowedBookEmoji(undefined), bookEmoji.options);
  assert.deepEqual(allowedBookEmoji({ bookEmojiChoices: [] }), []);
  assert.deepEqual(allowedBookEmoji({ bookEmojiChoices: ['book', 'fire'] }), ['book', 'fire']);
});

test('rejects repeated and unknown reaction choices', () => {
  assert.equal(bookEmojiChoices.safeParse(['heart', 'heart']).success, false);
  assert.equal(bookEmojiChoices.safeParse(['custom']).success, false);
  assert.deepEqual(allowedBookEmoji({ bookEmojiChoices: ['custom'] }), bookEmoji.options);
});
