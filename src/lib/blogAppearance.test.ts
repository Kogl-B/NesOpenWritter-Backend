import assert from 'node:assert/strict';
import { it } from 'node:test';
import { blogAppearanceSchema, readBlogAppearance } from './blogAppearance.js';

it('uses a consistent default for existing blogs', () => {
  const expected = { theme: 'forest', layout: 'cards', showDiscussions: true, showTopics: true };
  assert.deepEqual(readBlogAppearance(undefined), expected);
  assert.deepEqual(readBlogAppearance({}), expected);
});

it('keeps explicit false switches and rejects unsupported theme and layout values', () => {
  const appearance = { theme: 'plum', layout: 'compact', showDiscussions: false, showTopics: false };
  assert.deepEqual(readBlogAppearance(appearance), appearance);
  assert.equal(blogAppearanceSchema.safeParse({ ...appearance, theme: 'url(https://example.test/cover)' }).success, false);
  assert.equal(blogAppearanceSchema.safeParse({ ...appearance, layout: 'unknown' }).success, false);
});
