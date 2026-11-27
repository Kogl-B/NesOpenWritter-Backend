import assert from 'node:assert/strict';
import test from 'node:test';
import { filterCatalogBooks, pageCount, type SearchableBook } from './catalogSearch.js';

function book(patch: Partial<SearchableBook> & Pick<SearchableBook, 'title'>): SearchableBook {
  return {
    authorName: 'Автор',
    description: '',
    cycle: '',
    genres: [],
    genreNames: [],
    tags: [],
    status: 'writing',
    words: 1000,
    views: 1,
    likes: 0,
    favorites: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    textUpdatedAt: '2026-11-01T00:00:00.000Z',
    ...patch,
  };
}

test('страница считается как на Фикбуке, драббл не длиннее трёх', () => {
  assert.equal(pageCount(18838), 50);
  const books = [
    book({ title: 'Короткий', words: 400 }),
    book({ title: 'Мини', words: 5000 }),
    book({ title: 'Макси', words: 40000 }),
  ];
  const titles = filterCatalogBooks(books, { size: 'drabble' }, (id) => [id]).map((item) => item.title);
  assert.deepEqual(titles, ['Короткий']);
});

test('все указанные метки нужны, исключённая метка убирает книгу', () => {
  const books = [
    book({ title: 'Оба', tags: ['драма', 'юмор'] }),
    book({ title: 'Только драма', tags: ['драма'] }),
    book({ title: 'С войной', tags: ['драма', 'война'] }),
  ];
  const titles = filterCatalogBooks(books, { tag: 'драма, юмор', excludeTag: 'война' }, (id) => [id])
    .map((item) => item.title);
  assert.deepEqual(titles, ['Оба']);
});
