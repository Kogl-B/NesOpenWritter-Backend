import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkedContinuity, chooseEvidence, continuityMessages, continuitySources } from './continuity.js';

const manuscript = 'Ключ висел у Марка. Позже Рина открыла дверь.';
const world = [{ id: 'fact:key:period', title: 'Ключ · владелец', text: 'Ключ был у Леи.', source: { unitId: 'chapter', quote: 'Ключ у Леи.' } }];
const conflict = { title: 'Два владельца', kind: 'conflict', explanation: 'Указаны разные владельцы.' };
const gap = { title: 'Ключ', kind: 'gap', explanation: 'Откуда взялся ключ?' };
const mock = (...issues: unknown[]) => JSON.stringify({ issues });

test('ordinary mode submits only manuscript passages and advanced uses short opaque references', () => {
  const ordinary = JSON.parse(continuityMessages(continuitySources(manuscript, null))[1]!.content);
  assert.deepEqual(ordinary, { manuscript: [
    { id: 'T1', text: 'Ключ висел у Марка.' }, { id: 'T2', text: 'Позже Рина открыла дверь.' },
  ] });
  const advanced = JSON.parse(continuityMessages(continuitySources(manuscript, world))[1]!.content);
  assert.deepEqual(advanced.world, [{ ...world[0], id: 'W1', source: { quote: 'Ключ у Леи.' } }]);
  assert.equal(JSON.stringify(advanced).includes('fact:key:period'), false);
});

test('preserves a supported contradiction even when the model paraphrases a passage or adds an unknown source', () => {
  const result = checkedContinuity(continuitySources(manuscript, world), mock({
    ...conflict, evidence: [{ id: 'T1', excerpt: 'Ключ лежал у Марка.' }, { id: 'W1' }, { id: 'W999' }],
  }));
  assert.equal(result?.rejected, 0);
  assert.equal(result?.droppedReferences, 1);
  assert.deepEqual(result?.issues, [{ ...conflict, quotes: ['Ключ висел у Марка.'], world }]);
});

test('keeps audit reasons and rejects unknown, duplicated and world-only evidence', () => {
  const result = checkedContinuity(continuitySources(manuscript, world), mock(
    { ...conflict, evidence: [{ id: 'T1' }, { id: 'W77' }] },
    { ...conflict, evidence: [{ id: 'T1' }, { id: 'T1' }] },
    { ...gap, evidence: [{ id: 'W1' }] },
    { ...gap, quotes: ['Рина открыла дверь.'] },
    { ...gap, evidence: [{ id: 'T2', excerpt: 'Рина открыла дверь.' }] },
  ));
  assert.equal(result?.rejected, 4);
  assert.deepEqual(result?.rejections, { format: 1, unknownSource: 1, insufficientEvidence: 2, limit: 0 });
  assert.deepEqual(result?.issues, [{ ...gap, quotes: ['Рина открыла дверь.'], world: [] }]);
  assert.equal(checkedContinuity(continuitySources(manuscript, world), 'ошибка'), null);
});

test('supports two independent excerpts in one sentence while retaining the original manuscript text', () => {
  const text = 'В полдень ключ в руке у Марка, и в тот же момент ключ в ладони Леи.';
  const result = checkedContinuity(continuitySources(text, null), mock({
    ...conflict, evidence: [{ id: 'T1', excerpt: 'ключ в руке у Марка' }, { id: 'T1', excerpt: 'ключ в ладони Леи' }],
  }));
  assert.deepEqual(result?.issues[0]?.quotes, ['ключ в руке у Марка', 'ключ в ладони Леи']);
});

test('emits bounded passages without modifying letters, whitespace within passages or punctuation', () => {
  const text = 'В 19:00 капитан стоял там.\r\n«Не ждали», — подумал он. ' + 'стук '.repeat(180) + 'раздался.';
  const { manuscript } = continuitySources(text, null);
  assert.ok(manuscript.length >= 3);
  assert.ok(manuscript.every((row) => row.text.length <= 600 && text.includes(row.text)));
});

test('context prioritizes entries related to text within its budget', () => {
  const unrelated = Array.from({ length: 100 }, (_, i) => ({ id: 'city:' + i, title: 'Башня', text: 'А'.repeat(1200) }));
  const picked = chooseEvidence([[...unrelated, ...world]], manuscript);
  assert.equal(picked[0]?.id, 'fact:key:period');
  assert.ok(JSON.stringify(picked).length < 30_100);
});
