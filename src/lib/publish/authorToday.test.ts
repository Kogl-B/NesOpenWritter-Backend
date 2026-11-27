import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  authorTodayChapterBody,
  authorTodayChapterId,
  authorTodayChapterView,
  authorTodayChapters,
  authorTodayLoginGate,
  authorTodayLoginToken,
  parseAuthorTodayCookie,
  authorTodayToken,
  authorTodayUser,
  authorTodayWorksPage,
} from './authorToday.js';

describe('author today', () => {
  it('берёт ключ формы входа и не путает его с формой выхода', () => {
    const html = '<form id="logoff"><input name="__RequestVerificationToken" value="logoff-token-value"></form>'
      + '<form id="loginForm"><input type="hidden" name="__RequestVerificationToken" value="login-token-value-ok"></form>';
    assert.equal(authorTodayLoginToken(html), 'login-token-value-ok');
    assert.throws(() => authorTodayLoginToken('<form id="loginForm"></form>'), /форму входа/);
  });

  it('отличает отказ, код и успешный вход', () => {
    assert.throws(
      () => authorTodayLoginGate({ isSuccessful: false, messages: ['Неверный логин или пароль.'] }),
      /Неверный логин или пароль/,
    );
    assert.equal(authorTodayLoginGate({ isSuccessful: true, data: { twoFactorEnabled: true } }), 'two_factor');
    assert.equal(authorTodayLoginGate({ isSuccessful: true, data: { confirmEmailEnabled: true } }), 'email_code');
    assert.equal(authorTodayLoginGate({ isSuccessful: true, data: { redirectUrl: '/' } }), 'ok');
  });

  it('читает токен, имя и страницу произведений', () => {
    assert.deepEqual(authorTodayToken({ userId: 15, token: 'abc', expires: '2026-12-01T00:00:00Z' }).userId, 15);
    assert.equal(authorTodayUser({ id: 15, fio: 'Анна Книгина', userName: 'anna', email: 'hidden@example.com' }).name, 'Анна Книгина');
    assert.deepEqual(authorTodayWorksPage({
      totalCount: 2,
      items: [{ id: 100, title: 'Роман' }, { id: 'нет', title: 'пусто' }],
    }), {
      total: 2,
      works: [{ id: 100, title: 'Роман', url: 'https://author.today/work/100' }],
    });
  });

  it('берёт LoginCookie из значения и из строки cookie', () => {
    const cookie = 'abcDEF1234567890xyz_-';
    assert.equal(parseAuthorTodayCookie(cookie), cookie);
    assert.equal(parseAuthorTodayCookie(`theme=light; LoginCookie=${encodeURIComponent(cookie)}; other=1`), cookie);
    assert.throws(() => parseAuthorTodayCookie('   '), /Вставьте cookie LoginCookie/);
    assert.throws(() => parseAuthorTodayCookie('short'), /cookie LoginCookie/);
  });

  it('собирает тело главы и находит её номер в ответе', () => {
    const body = authorTodayChapterBody({
      workId: 100,
      title: 'Глава 1',
      html: '<p>Текст</p>',
      draft: false,
    });
    assert.equal(body.isDraft, false);
    assert.equal(body.autoPublishTime, '');
    assert.equal(body.text, '<p>Текст</p>');
    assert.equal(authorTodayChapterId({ chapterId: 77 }), 77);
    assert.deepEqual(authorTodayChapterView({
      data: { chapterId: 77, workId: 100, title: 'Глава 1', text: '<p>Текст</p>', chapterIsDraft: false },
    }), { id: 77, workId: 100, title: 'Глава 1', text: '<p>Текст</p>', draft: false });
    assert.deepEqual(authorTodayChapters({ chapters: [{ id: 77, title: 'Глава 1' }] }), [{ id: 77, title: 'Глава 1' }]);
  });
});
