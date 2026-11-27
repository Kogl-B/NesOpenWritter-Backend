import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { discordChannel, discordMessageApi, discordMessageUrl, parseDiscordWebhook } from './discord.js';

const URL = 'https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz0123456789';

describe('discord', () => {
  it('принимает вебхук канала и отвергает приглашение', () => {
    assert.deepEqual(parseDiscordWebhook(`  ${URL}/  `), {
      id: '123456789012345678',
      token: 'abcdefghijklmnopqrstuvwxyz0123456789',
    });
    assert.throws(() => parseDiscordWebhook('https://discord.gg/server'), /Приглашение на сервер/);
    assert.throws(() => parseDiscordWebhook(''), /Вставьте URL вебхука/);
  });

  it('берёт имя канала и не сохраняет токен', () => {
    const channel = discordChannel({
      name: 'Главы',
      channel_id: '223456789012345678',
      guild_id: '323456789012345678',
      token: 'secret-token',
      url: URL,
    });
    assert.deepEqual(channel, {
      name: 'Главы',
      channelId: '223456789012345678',
      guildId: '323456789012345678',
    });
    assert.equal(JSON.stringify(channel).includes('secret-token'), false);
    assert.throws(() => discordChannel({ name: 'Главы' }), /не назвал канал/);
  });

  it('собирает ссылку на сообщение в канале', () => {
    assert.equal(
      discordMessageUrl('323456789012345678', '223456789012345678', '423456789012345678'),
      'https://discord.com/channels/323456789012345678/223456789012345678/423456789012345678',
    );
    assert.equal(discordMessageUrl('1', '223456789012345678', '423456789012345678'), '');
  });

  it('собирает адрес правки того же сообщения', () => {
    const api = discordMessageApi(URL, '423456789012345678');
    assert.equal(api.endsWith('/messages/423456789012345678'), true);
    assert.throws(() => discordMessageApi(URL, '1'), /не нашёл сообщение/);
  });
});
