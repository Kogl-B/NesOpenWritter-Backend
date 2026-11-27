import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  parseWattpadToken,
  wattpadAuthKey,
  wattpadDeletePartForm,
  wattpadEditPartForm,
  wattpadHtml,
  wattpadNewPartForm,
  wattpadPartText,
  wattpadParts,
  wattpadSessionFromJson,
  wattpadStories,
  wattpadStorySettings,
  wattpadUser,
  wattpadLoginToken,
  wattpadUserId,
  wattpadWriteResult,
} from './wattpad.js';

const TOKEN = 'wattpad-session-token-value-123456';

describe('wattpad', () => {
  it('берёт cookie token из значения и из строки cookie', () => {
    assert.equal(parseWattpadToken(`  ${TOKEN}  `), TOKEN);
    assert.equal(parseWattpadToken(`lang=ru; token=${encodeURIComponent(TOKEN)}; other=1`), TOKEN);
    assert.equal(wattpadSessionFromJson(JSON.stringify({ token: TOKEN })), TOKEN);
    assert.throws(() => parseWattpadToken(''), /Вставьте cookie token/);
    assert.throws(() => parseWattpadToken('коротко'), /cookie token/);
  });

  it('берёт токен из ответа входа и отдаёт текст ошибки без пароля', () => {
    assert.equal(wattpadLoginToken({ token: TOKEN }), TOKEN);
    assert.equal(wattpadLoginToken({ data: { token: TOKEN } }), TOKEN);
    assert.throws(() => wattpadLoginToken({ error_code: 400, message: 'Login failed. Invalid user ID or password' }), /Invalid user ID or password/);
    assert.throws(() => wattpadLoginToken({}), /не выдал сессию/);
  });

  it('берёт имя и не подставляет почту', () => {
    assert.deepEqual(wattpadUser({ username: 'writer', name: 'Автор', email: 'hidden@example.com' }), {
      username: 'writer',
      name: 'Автор',
    });
    assert.equal(wattpadUser({ user: { username: 'writer' } }).name, 'writer');
    assert.throws(() => wattpadUser({ email: 'hidden@example.com' }), /не назвал аккаунт/);
  });

  it('читает свои истории и подставляет адрес', () => {
    assert.deepEqual(wattpadStories({
      stories: [
        { id: 123, title: 'Роман', url: 'https://www.wattpad.com/story/123-roman' },
        { storyId: '456', title: 'Черновик', url: 'https://example.com/no' },
        { id: 123, title: 'повтор' },
      ],
    }), [
      { id: 123, title: 'Роман', url: 'https://www.wattpad.com/story/123-roman' },
      { id: 456, title: 'Черновик', url: 'https://www.wattpad.com/story/456' },
    ]);
  });

  it('собирает черновик, правку и удаление главы', () => {
    assert.equal(wattpadAuthKey(`wattpad.apiAuthKey = 'Abcd1234efgh5678';`), 'Abcd1234efgh5678');
    assert.equal(wattpadUserId({ id: 77, email: 'hidden@example.com' }), 77);
    assert.deepEqual(wattpadStorySettings({ language: { id: 1, name: 'English' }, categories: [0, 14] }), {
      language: 1,
      category: 14,
    });
    assert.deepEqual(wattpadParts({
      parts: [
        { id: 10, title: 'Была', draft: false, url: 'https://www.wattpad.com/10-story' },
        { id: 11, title: 'Черновик', draft: true, deleted: true },
      ],
    }), [
      { id: 10, title: 'Была', url: 'https://www.wattpad.com/10-story', draft: false },
    ]);
    assert.equal(wattpadHtml('Первая\n\nВторая <b>'), '<p>Первая</p><p>Вторая &lt;b&gt;</p>');
    assert.equal(wattpadNewPartForm({
      storyId: 420285824,
      title: 'Проверка',
      html: '<p>Текст</p>',
      language: 1,
      category: 14,
    }).draft, '1');
    assert.equal(wattpadNewPartForm({
      storyId: 420285824,
      title: 'Проверка',
      html: '<p>Текст</p>',
      language: 1,
      category: 14,
    }).id, 'new');
    const edited = wattpadEditPartForm({
      partId: 99,
      storyId: 420285824,
      title: 'Правка',
      html: '<p>После</p>',
      textHash: 'e6ac8804',
      language: 1,
      category: 14,
    });
    assert.equal(edited.draft, 'true');
    assert.equal(edited.last_text_hash, 'e6ac8804');
    assert.equal(edited.req_type, 'edit');
    assert.equal(edited.publish, undefined);
    assert.equal(wattpadDeletePartForm(99, 77).id, '99');
    assert.equal(wattpadWriteResult({ id: 99, text_hash: 'e6ac8804', error_count: 0, errors: [] }).textHash, 'e6ac8804');
    assert.throws(() => wattpadWriteResult({ id: 99, text_hash: 'e6ac8804', error_count: 1 }), /не принял главу/);
    assert.equal(wattpadPartText({ text: '<p>После</p>', text_hash: 'ee414e20' }).html, '<p>После</p>');
  });
});
