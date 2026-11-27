import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  boostyProfile,
  expiresAtOf,
  boostyLoginFailure,
  boostyLoginSession,
  parseBoostySession,
  sessionExpired,
  sessionFromRefresh,
} from './boostySession.js';

const auth = {
  accessToken: 'access-token-value',
  refreshToken: 'refresh-token-value',
  expiresAt: 1_700_000_000_000,
};

describe('boosty session', () => {
  it('читает объект auth и отдельный идентификатор устройства', () => {
    const session = parseBoostySession(JSON.stringify({ auth, deviceId: 'device-1' }));
    assert.equal(session.accessToken, 'access-token-value');
    assert.equal(session.refreshToken, 'refresh-token-value');
    assert.equal(session.deviceId, 'device-1');
    assert.equal(session.expiresAt, '1700000000');
  });

  it('читает строку cookie', () => {
    const header = `auth=${encodeURIComponent(JSON.stringify(auth))}; _clientId=device-2`;
    const session = parseBoostySession(header);
    assert.equal(session.deviceId, 'device-2');
    assert.equal(session.accessToken, 'access-token-value');
  });

  it('читает auth строкой из cookie браузера', () => {
    const session = parseBoostySession(JSON.stringify({
      auth: encodeURIComponent(JSON.stringify(auth)),
      deviceId: 'device-3',
    }));
    assert.equal(session.deviceId, 'device-3');
    assert.equal(session.refreshToken, 'refresh-token-value');
  });

  it('читает cookie, где кавычки закодированы и значение разорвано переносом', () => {
    const broken = '{%22accessToken%22:%22access-token-value%22,%22refreshToken%22:%22refresh-\ntoken-value%22,%22expiresAt%22:1700000000000}';
    const session = parseBoostySession(JSON.stringify({ auth: broken, deviceId: 'device-4' }));
    assert.equal(session.accessToken, 'access-token-value');
    assert.equal(session.refreshToken, 'refresh-token-value');
    assert.equal(session.deviceId, 'device-4');
  });

  it('отклоняет сессию без идентификатора устройства', () => {
    assert.throws(() => parseBoostySession(JSON.stringify(auth)), /Идентификатор устройства/);
  });

  it('переводит срок из миллисекунд и считает его истёкшим заранее', () => {
    assert.equal(expiresAtOf(1_700_000_000_000), '1700000000');
    assert.equal(sessionExpired('1700000000', 1_700_000_000_000), true);
    assert.equal(sessionExpired('1700000000', 1_699_000_000_000), false);
  });

  it('собирает адрес блога и новую пару токенов', () => {
    assert.deepEqual(boostyProfile({ name: 'Автор', blogUrl: 'author' }), {
      name: 'Автор',
      blogUrl: 'https://boosty.to/author',
    });
    const next = sessionFromRefresh(
      { accessToken: 'old', refreshToken: 'old-r', deviceId: 'device-1', expiresAt: '1' },
      { access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600 },
    );
    assert.equal(next.accessToken, 'new-access');
    assert.equal(next.refreshToken, 'new-refresh');
    assert.equal(next.deviceId, 'device-1');
  });

  it('собирает сессию из ответа входа и не путает отказ с токеном', () => {
    const session = boostyLoginSession({
      access_token: 'access-token-value',
      refresh_token: 'refresh-token-value',
      expires_in: 3600,
    }, 'device-9');
    assert.equal(session.accessToken, 'access-token-value');
    assert.equal(session.refreshToken, 'refresh-token-value');
    assert.equal(session.deviceId, 'device-9');
    assert.equal(boostyLoginFailure(404, { error: 'not_found', error_description: 'Not found' }), 'Boosty не нашёл такой email');
    assert.throws(() => boostyLoginSession({}, 'device-9'), /не выдал сессию/);
  });
});
