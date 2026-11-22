import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  blogPostId,
  bookBlocked,
  catalogBookTarget,
  chapterBlocked,
  countryList,
  indexBlocks,
  isPrivateIp,
  postBlocked,
  publicIp,
  tokenMatches,
  trustedCountry,
} from './policy.js';

const index = indexBlocks([
  { kind: 'book', targetId: 'book-1', countries: ['ru', 'BY'] },
  { kind: 'chapter', targetId: 'ch-9', countries: ['RU'] },
  { kind: 'post', targetId: 'post-3', countries: ['DE'] },
  { kind: 'note', targetId: 'x', countries: ['RU'] },
]);

describe('geo policy', () => {
  it('берёт правый публичный адрес и игнорирует подставленный левый', () => {
    assert.equal(publicIp('8.8.8.8, 1.1.1.1'), '1.1.1.1');
    assert.equal(publicIp('1.2.3.4, 10.0.0.8'), '1.2.3.4');
    assert.equal(publicIp('::ffff:77.88.8.8'), '77.88.8.8');
    assert.equal(publicIp('127.0.0.1'), null);
    assert.equal(publicIp(''), null);
    assert.equal(isPrivateIp('192.168.0.1'), true);
    assert.equal(isPrivateIp('8.8.8.8'), false);
  });

  it('верит стране только при совпавшем секрете', () => {
    assert.equal(trustedCountry('ru', 'secret', 'secret'), 'RU');
    assert.equal(trustedCountry('RU', 'nope', 'secret'), null);
    assert.equal(trustedCountry('RU', 'secret', ''), null);
    assert.equal(trustedCountry('RUS', 'secret', 'secret'), null);
    assert.equal(tokenMatches('short', 'much-longer-token'), false);
  });

  it('закрывает книгу целиком, главу точечно и пост блога', () => {
    assert.equal(bookBlocked(index, 'RU', 'book-1'), true);
    assert.equal(bookBlocked(index, 'DE', 'book-1'), false);
    assert.equal(bookBlocked(index, null, 'book-1'), false);
    assert.equal(chapterBlocked(index, 'RU', 'book-1', 'other'), true);
    assert.equal(chapterBlocked(index, 'DE', 'book-2', 'ch-9'), false);
    assert.equal(chapterBlocked(index, 'RU', 'book-2', 'ch-9'), true);
    assert.equal(chapterBlocked(index, 'RU', 'book-2', 'ch-1'), false);
    assert.equal(postBlocked(index, 'DE', 'post-3'), true);
    assert.equal(postBlocked(index, 'RU', 'post-3'), false);
  });

  it('узнаёт публичные адреса книги и поста', () => {
    assert.deepEqual(catalogBookTarget('/api/catalog/books/book-1/like'), { bookId: 'book-1', chapterId: null });
    assert.deepEqual(catalogBookTarget('/api/catalog/books/book-1/chapters/ch-9?x=1'), { bookId: 'book-1', chapterId: 'ch-9' });
    assert.equal(catalogBookTarget('/api/catalog/home'), null);
    assert.equal(blogPostId('/api/blog/post-3/comments'), 'post-3');
    assert.equal(blogPostId('/api/blog'), null);
    assert.equal(blogPostId('/api/blog/authors/user-1'), null);
  });

  it('не принимает неизвестный код страны', () => {
    assert.deepEqual(countryList(['ru', 'RU']), { ok: ['RU'] });
    assert.deepEqual(countryList(['XX']), { error: 'Неизвестная страна' });
    assert.deepEqual(countryList([]), { error: 'Укажите страну' });
  });
});
