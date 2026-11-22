import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { sponsrClock, sponsrManageForm } from './sponsrManage.js';

describe('sponsr manage form', () => {
  it('публикует открытый пост и не зовёт подписчиков, пока это не сказано', () => {
    const body = sponsrManageForm({
      projectId: 10649,
      title: 'Проверка',
      html: '<p>Текст</p>',
      notify: false,
      date: '2026-11-22 15:30:00',
    });
    assert.equal(body.get('project_id'), '10649');
    assert.equal(body.get('post_id'), null);
    assert.equal(body.get('post_status'), 'active');
    assert.equal(body.get('post_notified'), '1');
    assert.equal(body.get('level_id'), '');
    assert.equal(body.get('post_access_type'), 'def');
  });

  it('правит существующий пост и ставит московское время', () => {
    const body = sponsrManageForm({
      projectId: 10649,
      postId: 196350,
      title: 'Правка',
      html: '<p>Новый текст</p>',
      notify: true,
      date: sponsrClock(new Date('2026-11-22T12:00:00.000Z')),
    });
    assert.equal(body.get('post_id'), '196350');
    assert.equal(body.get('post_notified'), '0');
    assert.equal(body.get('post_date'), '2026-11-22 15:00:00');
  });
});