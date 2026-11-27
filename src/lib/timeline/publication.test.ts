import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isTimelineReady } from './publication.js';

test('для хронологии доступна только опубликованная глава', () => {
  for (const stage of [undefined, null, '', 'new', 'writing', 'done', 'checked', 'scheduled']) {
    assert.equal(isTimelineReady(stage), false, String(stage));
  }
  assert.equal(isTimelineReady('published'), true);
});
