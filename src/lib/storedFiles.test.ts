import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseStoredKey } from './storedFiles.js';

describe('parseStoredKey', () => {
  it('принимает файл из кабинета этого аккаунта', () => {
    assert.deepEqual(
      parseStoredKey('users/user-1/projects/book/other/179-photo.jpg', 'user-1'),
      { projectId: 'book', kind: 'other' },
    );
    assert.deepEqual(
      parseStoredKey('users/user-1/projects/book/portrait/1-face.jpg', 'user-1'),
      { projectId: 'book', kind: 'portrait' },
    );
  });

  it('отклоняет чужой кабинет и кривой ключ', () => {
    assert.equal(parseStoredKey('users/other/projects/book/other/a.jpg', 'user-1'), null);
    assert.equal(parseStoredKey('users/user-1/projects/book', 'user-1'), null);
    assert.equal(parseStoredKey('users/user-1/../projects/book/other/a.jpg', 'user-1'), null);
  });
});
