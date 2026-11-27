import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyWorldCellChanges, applyWorldReaderRules, applyWorldTableChanges } from './worldTableChanges.js';

test('updates one table without changing other tables or dropping a photo saved by the server', () => {
  const untouched = { id: 'untouched', rows: [{ id: 'old', cells: { title: 'Старая запись' } }] };
  const urls = 'https://example.test/photo.jpg';
  const table = { id: 'edited', columns: [{ id: 'photo', kind: 'photo' }],
    rows: [{ id: 'line', cells: { photo: urls } }] };
  const edited = { id: 'edited', columns: [], rows: [{ id: 'line', cells: { title: 'Новый текст' } }] };
  const changed = applyWorldTableChanges([table, untouched], { upsert: [edited], remove: [] });
  assert.equal(changed.tables[1], untouched);
  assert.deepEqual(changed.upsert[0]?.rows, [{ id: 'line', cells: { title: 'Новый текст', photo: urls } }]);
  assert.deepEqual(changed.upsert[0]?.columns, table.columns);
});

test('keeps table order and applying a retry does not create a second table', () => {
  const changes = { upsert: [{ id: 'b', title: 'Новое имя' }, { id: 'd' }], remove: ['a'] };
  const expected = [{ id: 'b', title: 'Новое имя' }, { id: 'c' }, { id: 'd' }];
  const first = applyWorldTableChanges([{ id: 'a' }, { id: 'b' }, { id: 'c' }], changes);
  assert.deepEqual(first.tables, expected);
  assert.deepEqual(applyWorldTableChanges(first.tables, changes).tables, expected);
});

test('keeps other cells, including a photo added meanwhile, and rejects a missing column', () => {
  const photo = 'https://example.test/new.jpg';
  const input = [{ id: 't', columns: [{ id: 'a', kind: 'text' }, { id: 'p', kind: 'photo' }],
    rows: [{ id: 'r', cells: { a: 'До', p: photo } }, { id: 'other', cells: { a: 'Сосед' } }] }];
  const edit = { tableId: 't', rowId: 'r', columnId: 'a', kind: 'text', value: 'После' };
  assert.deepEqual(applyWorldCellChanges(input, [edit]), [
    { ...input[0]!, rows: [{ id: 'r', cells: { a: 'После', p: photo } }, input[0]!.rows[1]] },
  ]);
  assert.equal(applyWorldCellChanges(input, [{ ...edit, columnId: 'removed' }]), null);
  assert.equal(input[0]!.rows[0]!.cells.a, 'До');
});

test('keeps saved disclosure rules across structural updates and clears them only via explicit edits', () => {
  const columns = [{ id: 'name', kind: 'text' }, { id: 'photo', kind: 'photo' }];
  const before = [{ id: 'table', columns, rows: [{ id: 'row', readerVisibility: { name: 'private', photo: 'chapter' } }] }];
  const stale = [{ id: 'table', columns, rows: [{ id: 'row', cells: { name: 'Маяк' } }] }];
  const { tables } = applyWorldTableChanges(before, { upsert: stale, remove: [] });
  assert.deepEqual(tables, [{ ...stale[0], rows: [{ ...stale[0]!.rows[0], readerVisibility: { name: 'private', photo: 'chapter' } }] }]);
  const clear = { tableId: 'table', rowId: 'row', columnId: 'name', rule: '' };
  assert.deepEqual(applyWorldReaderRules(tables, [clear]), [
    { ...stale[0], rows: [{ ...stale[0]!.rows[0], readerVisibility: { photo: 'chapter' } }] },
  ]);
  assert.equal(applyWorldReaderRules(tables, [{ ...clear, columnId: 'missing' }]), null);
});
