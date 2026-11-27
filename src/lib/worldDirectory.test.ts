import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { directoryCard, directoryFieldVisible, publicDirectoryContent } from './worldDirectory.js';

const settings = { worldTables: [{
  id: 'table', title: 'Город', titleColumnId: 'name',
  columns: [
    { id: 'name', name: 'Название', kind: 'text' },
    { id: 'photo', name: 'Фото', kind: 'photo' },
    { id: 'fact', name: 'Факт', kind: 'text' },
  ],
  rows: [{
    id: 'row', readerVisibility: { name: 'private', photo: 'private' },
    cells: { name: 'Тайное имя', fact: 'Маяк работает', photo: 'https://example.test/private.png' },
  }],
}] };
const input = { id: randomUUID(), tableId: 'table', rowId: 'row', fields: ['name', 'photo', 'fact'], label: 'Тайное имя', imageColumnId: 'photo' };

test('private title and photo are absent from public cards and manuscript labels', async () => {
  const card = await directoryCard('project', settings, input, { chapterId: 'chapter', isBlocked: () => false });
  assert.deepEqual(card, {
    title: 'Запись справочника', table: 'Город',
    fields: [{ id: 'fact', label: 'Факт', kind: 'text', value: 'Маяк работает' }],
  });
  const doc = { type: 'doc', content: [{ type: 'directoryReference', attrs: input }] };
  assert.equal(JSON.stringify(publicDirectoryContent(settings, doc)).includes('Тайное имя'), false);
  assert.equal(JSON.stringify(publicDirectoryContent(settings, doc)).includes('Справка'), true);
  assert.equal((await directoryCard('project', settings, input))?.title, 'Тайное имя');
});

test('visibility starts at the specified chapter and fails closed when the chapter is missing', () => {
  const base = { id: 'first', orderIndex: 2, createdAt: new Date('2026-01-01') };
  const later = { ...base, id: 'later', orderIndex: 3 };
  assert.equal(directoryFieldVisible('later', base, later), false);
  assert.equal(directoryFieldVisible('later', later, later), true);
  assert.equal(directoryFieldVisible('first', later, base), true);
  assert.equal(directoryFieldVisible('missing', later, undefined), false);
  assert.equal(directoryFieldVisible('private', later, base), false);
  assert.equal(directoryFieldVisible(undefined, undefined, undefined), true);
});

test('legacy references keep their labels, unresolved references use neutral labels', () => {
  const legacy = structuredClone(settings);
  legacy.worldTables[0]!.rows[0]!.readerVisibility = {} as { name: string; photo: string };
  const doc = { type: 'directoryReference', attrs: input };
  assert.equal(JSON.stringify(publicDirectoryContent(legacy, doc)).includes('Тайное имя'), true);
  assert.equal(JSON.stringify(publicDirectoryContent({}, doc)).includes('Тайное имя'), false);
});
