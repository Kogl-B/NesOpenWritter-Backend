import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { coverHref, mergeWorldTablePhotos, placeCoverInSettings, placePhotoInSettings } from './place.js';

describe('результат генерации в настройках книги', () => {
  const settings = {
    cover: 'keep',
    worldTables: [{
      id: 't1',
      columns: [
        { id: 'a', name: 'Имя', kind: 'text' },
        { id: 'b', name: 'Фото', kind: 'photo' },
      ],
      pictureColumnIds: ['b'],
      rows: [{ id: 'lift', cells: { a: 'Лифт' } }],
    }, {
      id: 't2',
      rows: [{ id: 'other', cells: { a: 'целая' } }],
    }],
  };

  it('пишет фото в строку и оставляет остальные таблицы', () => {
    const next = placePhotoInSettings(settings, 't1', 'lift', 'https://cdn.example/lift.jpg');
    assert.equal(next.cover, 'keep');
    const tables = next.worldTables as Array<{ id: string; rows: Array<{ cells: Record<string, string> }> }>;
    assert.equal(tables[0]?.rows[0]?.cells.b, 'https://cdn.example/lift.jpg');
    assert.equal(tables[0]?.rows[0]?.cells.a, 'Лифт');
    assert.equal(tables[1]?.rows[0]?.cells.a, 'целая');
  });

  it('не подставляет адрес, который нельзя открыть как картинку', () => {
    const next = placePhotoInSettings(settings, 't1', 'lift', 'javascript:alert(1)');
    const tables = next.worldTables as Array<{ rows: Array<{ cells: Record<string, string> }> }>;
    assert.equal(tables[0]?.rows[0]?.cells.b, undefined);
  });

  it('не заводит строку, которой в таблице нет', () => {
    const next = placePhotoInSettings(settings, 't1', 'missing', 'https://cdn.example/lift.jpg');
    const tables = next.worldTables as Array<{ rows: Array<{ id: string }> }>;
    assert.equal(tables[0]?.rows.length, 1);
  });

  it('ставит обложку только по https', () => {
    const next = placeCoverInSettings(settings, 'https://cdn.example/cover.jpg');
    assert.equal(next.cover, 'https://cdn.example/cover.jpg');
    assert.equal(placeCoverInSettings(settings, 'http://cdn.example/cover.jpg').cover, 'keep');
  });

  it('оставляет серверное фото, если клиент прислал пустую ячейку', () => {
    const existing = [{
      id: 't1',
      columns: [{ id: 'b', kind: 'photo' }],
      rows: [{ id: 'lift', cells: { b: 'https://cdn.example/lift.jpg' } }],
    }];
    const incoming = [{
      id: 't1',
      columns: [{ id: 'b', kind: 'photo' }],
      rows: [{ id: 'lift', cells: { a: 'Лифт', b: '' } }],
    }];
    const merged = mergeWorldTablePhotos(existing, incoming) as Array<{ rows: Array<{ cells: Record<string, string> }> }>;
    assert.equal(merged[0]?.rows[0]?.cells.b, 'https://cdn.example/lift.jpg');
    assert.equal(merged[0]?.rows[0]?.cells.a, 'Лифт');
  });

  it('принимает в каталоге и data URL, и публичную ссылку', () => {
    assert.equal(coverHref('https://cdn.example/cover.jpg'), 'https://cdn.example/cover.jpg');
    assert.equal(coverHref('data:image/jpeg;base64,abc'), 'data:image/jpeg;base64,abc');
    assert.equal(coverHref('javascript:alert(1)'), '');
    assert.equal(coverHref(`https://cdn.example/${'a'.repeat(2100)}`), '');
  });
});
