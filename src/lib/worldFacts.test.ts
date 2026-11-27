import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { factInput, factPeriods, readWorldFacts, updateFact } from './worldFacts.js';

const factId = randomUUID();
const who = 'writer';
const now = '2026-11-27T10:00:00.000Z';
const first = factInput.parse({
  revisionId: randomUUID(), action: 'create', subject: { kind: 'item', id: 'key', name: 'Ключ' },
  field: 'Владелец', value: 'Лея', certainty: 'canon', from: '',
  eventId: null, source: { unitId: 'chapter', quote: 'Ключ лежал у Леи' },
});

test('story changes open new periods and canon corrections keep audit history', () => {
  const created = updateFact(undefined, factId, first, who, now);
  assert.ok(created.changed);
  const story = factInput.parse({
    ...first, action: 'story', previousId: first.revisionId, revisionId: randomUUID(), value: 'Марк', eventId: 'siege', source: null,
  });
  const advanced = updateFact(created.fact, factId, story, who, now);
  assert.ok(advanced.changed);
  const correction = factInput.parse({
    ...first, action: 'correct', previousId: story.revisionId, periodId: first.revisionId, revisionId: randomUUID(), value: 'Рина',
  });
  const result = updateFact(advanced.fact, factId, correction, who, now);
  assert.ok(result.changed);
  assert.deepEqual(factPeriods(result.fact).map((entry) => entry.value), ['Рина', 'Марк']);
  assert.deepEqual(result.fact.revisions.map((entry) => entry.value), ['Лея', 'Марк', 'Рина']);
  assert.deepEqual(readWorldFacts([result.fact]), [result.fact]);
  assert.equal(updateFact(result.fact, factId, correction, who, now).changed, false);
  assert.match(updateFact(result.fact, factId, { ...correction, revisionId: randomUUID() }, who, now).issue!, /изменился/);
});

test('requires a story time for a new period', () => {
  assert.equal(factInput.safeParse({ ...first, action: 'story', previousId: first.revisionId }).success, false);
});
