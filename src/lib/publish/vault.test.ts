import assert from 'node:assert/strict';
import test from 'node:test';

import { accessError, isVaultPlatform, passwordLoginPlatforms, publicVaultPlatforms, serverVault, vaultBody } from './vault.js';

const seal = `v1.${'a'.repeat(16)}.${'b'.repeat(32)}`;

test('вход принимается только парой шифров', () => {
  assert.equal(vaultBody.safeParse({ platform: 'discord', loginSeal: seal, passwordSeal: seal }).success, true);
  assert.equal(vaultBody.safeParse({ platform: 'discord', login: 'ann', password: 'secret' }).success, false);
  assert.equal(vaultBody.safeParse({ platform: 'discord', loginSeal: 'secret', passwordSeal: seal }).success, false);
  assert.equal(vaultBody.safeParse({
    platform: 'discord',
    loginSeal: seal,
    passwordSeal: seal,
    password: 'secret',
  }).success, false);
});

test('площадки входа совпадают с карточками автопоста', () => {
  assert.equal(isVaultPlatform('discord'), true);
  assert.equal(isVaultPlatform('site'), false);
});

test('кабинет видит только площадку, не шифр и не серверный пароль', () => {
  const rows = publicVaultPlatforms([
    { platform: 'discord', loginSeal: seal, passwordSeal: seal },
    { platform: 'wattpad', loginSeal: 'server-login', passwordSeal: 'server-password' },
  ]);
  assert.deepEqual(rows, ['discord']);
  assert.equal(JSON.stringify(rows).includes('server-password'), false);
  assert.deepEqual(passwordLoginPlatforms([
    { platform: 'discord', loginSeal: seal, passwordSeal: seal },
    { platform: 'boosty', loginSeal: 'server-login', passwordSeal: 'server-password' },
  ]), ['boosty']);
  assert.equal(serverVault(seal, seal), null);
});

test('текст ошибки проверки не уносит ключ', () => {
  const message = accessError(new Error('fail bot123:ABCDE_token access_token=secret'));
  assert.equal(message.includes('ABCDE_token'), false);
  assert.equal(message.includes('secret'), false);
});
