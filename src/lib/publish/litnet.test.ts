import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { litnetBooksPage, litnetChapterForm, litnetChapterList, litnetFormError, litnetUser, parseLitnetToken } from './litnet.js';

const TOKEN = 'eyJhbGciOiJub25lIn0.eyJzdWIiOiIxIn0.signaturevalue';

describe('litnet', () => {
  it('берёт токен из значения и из строки cookie', () => {
    assert.equal(parseLitnetToken(TOKEN), TOKEN);
    assert.equal(parseLitnetToken(`theme=light; _internal_access_token=${encodeURIComponent(TOKEN)}; other=1`), TOKEN);
    assert.throws(() => parseLitnetToken('   '), /Вставьте cookie _internal_access_token/);
    assert.throws(() => parseLitnetToken('not-a-jwt'), /cookie _internal_access_token/);
  });

  it('берёт имя и не подставляет почту', () => {
    assert.equal(litnetUser({ id: 15, name: 'Анна Книгина', email: 'hidden@example.com' }).name, 'Анна Книгина');
    assert.throws(() => litnetUser({ id: 15, email: 'hidden@example.com' }), /не назвал аккаунт/);
  });

  it('читает страницу своих книг', () => {
    assert.deepEqual(litnetBooksPage({
      items: [
        { id: 100, title: 'Роман', alias: 'roman-b100' },
        { id: 'нет', title: 'пусто' },
      ],
    }), [{ id: 100, title: 'Роман', url: 'https://litnet.com/ru/book/roman-b100' }]);
  });

  it('читает форму главы и оглавление', () => {
    const form = litnetChapterForm(`
      <form id="chapter-add-form" action="/account/chapter/edit?id=50" method="post">
        <input type="hidden" name="_csrf" value="csrf-fixture">
        <input type="text" id="chapterform-title" name="ChapterForm[title]" value="Первая">
        <textarea id="chapterform-text">&lt;p&gt;&amp;#x422;&#x435;&#x43a;&#x441;&#x442;&lt;/p&gt;</textarea>
        <input type="radio" name="ChapterForm[publish_type]" value="0">
        <input type="radio" name="ChapterForm[publish_type]" value="1" checked>
      </form>
      <script>const bookId = '70';</script>
    `);
    assert.equal(form?.chapterId, 50);
    assert.equal(form?.bookId, 70);
    assert.equal(form?.title, 'Первая');
    assert.equal(form?.text, '<p>Текст</p>');
    assert.equal(form?.draft, true);
    assert.equal(litnetChapterForm('<html></html>'), null);
    assert.equal(litnetFormError('<p class="help-block help-block-error">Название слишком длинное</p>'), 'Название слишком длинное');
    assert.deepEqual(litnetChapterList(`
      <div class="book_parts" id="50">
        <a href="/account/chapter/edit?id=50">Первая</a>
        <span class="book_parts_status">Черновик</span>
        <a href="/ru/reader/roman-b70?c=50">Открыть</a>
      </div>
    `), [{ id: 50, title: 'Первая', draft: true, url: 'https://litnet.com/ru/reader/roman-b70?c=50' }]);
  });
});
