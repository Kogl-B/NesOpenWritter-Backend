import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  telegramAdminOk,
  telegramChannelKeyboard,
  telegramEvent,
  telegramInviteHash,
  telegramLinked,
  telegramRights,
} from './telegramBot.js';

describe('telegram bot', () => {
  it('узнаёт ссылку, права и выбранный канал', () => {
    const start = telegramEvent({
      message: { message_id: 1, from: { id: 7, first_name: 'Аня' }, chat: { id: 7, type: 'private' }, text: '/start abc_12' },
    });
    assert.equal(start.kind, 'start');
    assert.equal(start.code, 'abc_12');
    assert.equal(start.telegramUserId, 7);
    assert.equal(telegramEvent({
      message: { from: { id: 7, first_name: 'Аня' }, chat: { id: 7 }, text: '/channel' },
    }).kind, 'rights');
    const shared = telegramEvent({
      message: {
        from: { id: 7, first_name: 'Аня' },
        chat: { id: 7, type: 'private' },
        chat_shared: { request_id: 1, chat_id: -100123 },
      },
    });
    assert.equal(shared.kind, 'shared');
    assert.equal(shared.sharedChatId, '-100123');
    assert.equal(telegramEvent({
      callback_query: { id: 'cb', from: { id: 7, first_name: 'Аня' }, data: 'check' },
    }).kind, 'check');
  });

  it('просит у канала публикацию, правку и удаление', () => {
    const button = telegramChannelKeyboard().keyboard[0]?.[0];
    const rights = button?.request_chat.bot_administrator_rights as Record<string, boolean>;
    assert.equal(button?.text, 'Выбрать канал');
    assert.equal(button?.request_chat.chat_is_channel, true);
    assert.equal(rights.can_post_messages, true);
    assert.equal(rights.can_edit_messages, true);
    assert.equal(rights.can_delete_messages, true);
    assert.equal(rights.can_promote_members, false);
    const linked = telegramLinked('OpenWrittenBot');
    assert.match(linked[1]?.text ?? '', /Публикация сообщений/);
    assert.equal(linked[1]?.inline?.[0]?.[0]?.callback_data, 'rights');
    assert.match(telegramRights('OpenWrittenBot')[0]?.text ?? '', /@OpenWrittenBot/);
    assert.equal(telegramAdminOk({ status: 'creator' }).ok, true);
    assert.deepEqual(telegramAdminOk({ status: 'administrator', can_post_messages: true }).missing, [
      'изменение сообщений',
      'удаление сообщений',
    ]);
    assert.equal(telegramInviteHash('abc'), telegramInviteHash('abc'));
    assert.notEqual(telegramInviteHash('abc'), telegramInviteHash('abd'));
  });
});