import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { imageUrlsFromText, isImageFile, mergePhotos, pagePhotos, photoHref, photosInSettings, type AccountPhoto } from './accountPhotos.js';

function photo(patch: Partial<AccountPhoto> & Pick<AccountPhoto, 'href' | 'place'>): AccountPhoto {
  return {
    id: 'x',
    title: 'Кадр',
    placeLabel: '',
    projectName: '',
    at: '2026-11-01T00:00:00.000Z',
    ...patch,
  };
}

describe('фото кабинета', () => {
  it('отличает картинку от текстового файла', () => {
    assert.equal(isImageFile('users/u/1-photo.jpg'), true);
    assert.equal(isImageFile('users/u/e2e-check.txt'), false);
  });

  it('берёт https, data URL и ключ хранилища', () => {
    assert.equal(photoHref('https://cdn.example/lift.jpg'), 'https://cdn.example/lift.jpg');
    assert.equal(photoHref('data:image/jpeg;base64,abc'), 'data:image/jpeg;base64,abc');
    assert.equal(photoHref('users/u/projects/p/other/1-photo.jpg', 'https://cdn.example'), 'https://cdn.example/users/u/projects/p/other/1-photo.jpg');
    assert.equal(photoHref('javascript:alert(1)'), '');
    assert.equal(photoHref('https://cdn.example/page'), 'https://cdn.example/page');
  });

  it('из текста берёт только картинки', () => {
    const urls = imageUrlsFromText('Смотри https://site.test/book и https://cdn.example/lift.jpg, ещё data:image/png;base64,aaaa');
    assert.deepEqual(urls, ['https://cdn.example/lift.jpg', 'data:image/png;base64,aaaa']);
  });

  it('собирает обложку и фото строки', () => {
    const photos = photosInSettings({
      cover: 'https://cdn.example/cover.jpg',
      worldTables: [{
        title: 'Аномалии',
        columns: [{ id: 'a', kind: 'text' }, { id: 'b', kind: 'photo' }],
        rows: [{ id: 'r1', cells: { a: 'Лифт', b: 'https://cdn.example/lift.jpg' } }],
      }],
    }, 'Хроники', '2026-11-23T00:00:00.000Z');
    assert.deepEqual(photos.map((item) => `${item.place}:${item.title}`), [
      'cover:Хроники',
      'table:Аномалии · Лифт',
    ]);
  });

  it('оставляет один адрес и предпочитает обложку файлу хранилища', () => {
    const href = 'https://cdn.example/cover.jpg';
    const merged = mergePhotos([[
      photo({ href, place: 'file', title: 'cover.jpg', at: '2026-11-02T00:00:00.000Z' }),
      photo({ href, place: 'cover', title: 'Хроники', at: '2026-11-01T00:00:00.000Z' }),
      photo({ href: 'https://cdn.example/lift.jpg', place: 'table', title: 'Лифт', at: '2026-11-03T00:00:00.000Z' }),
    ]]);
    assert.equal(merged.length, 2);
    assert.equal(merged[0]?.title, 'Лифт');
    assert.equal(merged[1]?.place, 'cover');
  });

  it('режет страницу по 24', () => {
    const rows = Array.from({ length: 30 }, (_, index) => photo({
      href: `https://cdn.example/${index}.jpg`,
      place: 'file',
      title: String(index),
      at: `2026-11-${String((index % 28) + 1).padStart(2, '0')}T00:00:00.000Z`,
    }));
    const page = pagePhotos(rows, 2, 24);
    assert.equal(page.total, 30);
    assert.equal(page.page, 2);
    assert.equal(page.photos.length, 6);
  });
});
