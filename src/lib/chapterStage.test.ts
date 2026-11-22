import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { assertScheduledDate, chapterPublishAt, chapterTags } from './chapterStage.js';

describe('chapter stage', () => {
  it('оставляет уникальные теги', () => {
    assert.deepEqual(chapterTags(['  Романтика ', 'романтика', '', 'медленный сюжет']), ['Романтика', 'медленный сюжет']);
  });

  it('требует дату только у запланированной публикации', () => {
    assert.throws(() => assertScheduledDate('scheduled', null), /дату и время/);
    assert.doesNotThrow(() => assertScheduledDate('done', null));
    const date = chapterPublishAt('2026-12-01T18:30');
    assert.ok(date instanceof Date);
    assert.equal(chapterPublishAt(''), null);
  });
});
