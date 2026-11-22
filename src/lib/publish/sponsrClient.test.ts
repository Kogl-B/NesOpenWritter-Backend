import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { sponsrDocument, sponsrFailure, sponsrPostBody, sponsrProjectsFrom } from './sponsrClient.js';

describe('sponsr post', () => {
  it('собирает ссылку, картинку и не берёт чужой адрес', () => {
    const html = sponsrDocument({
      body: '<p>Текст</p>',
      url: 'https://example.com/read/1?c=2',
      links: [{ url: 'http://example.com/no', title: 'мимо' }, { url: 'https://example.com/yes', title: 'Да' }],
      images: [{ url: 'https://images.example/a.png', alt: 'Кадр <' }],
    });
    assert.match(html, /Читать на сайте/);
    assert.match(html, /https:\/\/example.com\/yes/);
    assert.equal(html.includes('http://example.com'), false);
    assert.match(html, /alt="Кадр &lt;"/);
  });

  it('не оповещает только когда это сказано и не шлёт пустой уровень', () => {
    const quiet = sponsrPostBody({
      title: 'Проверка',
      html: '<p></p>',
      date: '2026-11-22T12:00:00.000Z',
      levelId: null,
      notify: false,
    });
    assert.equal(quiet.is_notified, true);
    assert.equal('level_id' in quiet, false);
    assert.equal(quiet.date, '2026-11-22T12:00:00.000Z');
    const open = sponsrPostBody({
      title: 'Проверка',
      html: '<p></p>',
      date: '2026-11-22T12:00:00.000Z',
      levelId: 12,
    });
    assert.equal(open.level_id, 12);
    assert.equal(open.is_notified, false);
  });

  it('читает проект из карточки и из списка', () => {
    const one = sponsrProjectsFrom({
      data: { id: 8748, project_title: 'Проект для примера', project_url: 'projecttest' },
    });
    assert.deepEqual(one, [{ id: 8748, title: 'Проект для примера', url: 'https://sponsr.ru/projecttest' }]);
    const list = sponsrProjectsFrom({
      list: [
        { id: 1, project_title: 'Первый', project_url: 'one' },
        { id: 1, project_title: 'Первый', project_url: 'one' },
        { id: 2, project_title: 'Чужой', project_url: 'https://evil.example/x' },
      ],
    });
    assert.deepEqual(list, [{ id: 1, title: 'Первый', url: 'https://sponsr.ru/one' }]);
  });

  it('переводит отказ ключа и не повторяет сам ключ', () => {
    assert.equal(sponsrFailure(401, { message: 'Unauthorized secret-key' }), 'Sponsr не принял ключ');
    assert.match(sponsrFailure(403, { message: 'Api key expired' }), /просрочен/);
    assert.equal(sponsrFailure(400, { message: ['title must be longer than or equal to 4 characters'] }), 'Заголовок Sponsr короче 4 знаков');
  });
});
