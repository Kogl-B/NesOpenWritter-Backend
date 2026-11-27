import { createHash, randomBytes } from 'node:crypto';

export const BOT_CHANNEL_RIGHTS = {
  is_anonymous: false,
  can_manage_chat: false,
  can_delete_messages: true,
  can_manage_video_chats: false,
  can_restrict_members: false,
  can_promote_members: false,
  can_change_info: false,
  can_invite_users: false,
  can_post_stories: false,
  can_edit_stories: false,
  can_delete_stories: false,
  can_post_messages: true,
  can_edit_messages: true,
  can_pin_messages: false,
  can_manage_topics: false,
} as const;

export interface TelegramButton {
  text: string;
  callback_data: string;
}

export interface TelegramOutgoing {
  text: string;
  inline?: TelegramButton[][];
  pickChannel?: boolean;
}

export interface TelegramEvent {
  kind: 'start' | 'rights' | 'check' | 'unlink' | 'shared' | 'member' | 'ignore';
  replyChatId: number;
  telegramUserId: number;
  name: string;
  code: string;
  callbackId: string;
  sharedChatId: string;
  memberChatId: string;
  memberTitle: string;
  memberStatus: string;
  member: unknown;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown, limit = 80): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, limit) : '';
}

function whole(value: unknown): number {
  const id = typeof value === 'number' ? value : typeof value === 'string' && /^-?\d+$/.test(value) ? Number(value) : 0;
  return Number.isSafeInteger(id) && id !== 0 ? id : 0;
}

export function telegramInviteCode(): string {
  return randomBytes(18).toString('base64url');
}

export function telegramInviteHash(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

/** Кнопка «Выбрать канал»: Telegram сам предлагает выдать боту права. */
export function telegramChannelKeyboard(): {
  keyboard: Array<Array<{ text: string; request_chat: Record<string, unknown> }>>;
  resize_keyboard: true;
  is_persistent: true;
} {
  return {
    keyboard: [[{
      text: 'Выбрать канал',
      request_chat: {
        request_id: 1,
        chat_is_channel: true,
        bot_is_member: false,
        user_administrator_rights: {
          ...BOT_CHANNEL_RIGHTS,
          can_manage_chat: true,
          can_promote_members: true,
          can_post_messages: true,
        },
        bot_administrator_rights: BOT_CHANNEL_RIGHTS,
      },
    }]],
    resize_keyboard: true,
    is_persistent: true,
  };
}

const ACTIONS: TelegramButton[][] = [[
  { text: 'Как добавить права', callback_data: 'rights' },
  { text: 'Проверить канал', callback_data: 'check' },
], [
  { text: 'Отключить канал', callback_data: 'unlink' },
]];

function named(value: string): string {
  const name = value.trim();
  return name ? name.slice(0, 80) : 'читатель';
}

export function telegramClosed(): TelegramOutgoing[] {
  return [{
    text: 'Это бот OpenWritter. Он выпускает новые главы в ваш канал.\n\nСначала откройте сайт: кабинет → Автопост → Telegram и нажмите «Подключить». Ссылка откроет этот чат и свяжет его с вашим аккаунтом.',
  }];
}

export function telegramStale(): TelegramOutgoing[] {
  return [{
    text: 'Ссылка устарела или уже использована. На сайте в разделе «Автопост» нажмите «Подключить» ещё раз.',
  }];
}

export function telegramLinked(botUsername: string): TelegramOutgoing[] {
  const bot = botUsername.replace(/^@/, '');
  return [
    { text: 'Кнопка внизу выбирает канал и сразу предлагает права для бота.', pickChannel: true },
    {
      text: [
        'Аккаунт OpenWritter подключён.',
        '',
        'Дальше привяжите канал, куда выходят главы.',
        '1. Нажмите «Выбрать канал» внизу и укажите свой канал. Telegram спросит права.',
        `2. Вручную: канал → Администраторы → Добавить администратора → найдите @${bot}.`,
        '3. Включите три права: «Публикация сообщений», «Изменение сообщений», «Удаление сообщений». Остальные не нужны.',
        '4. Нажмите «Проверить канал».',
        '',
        'Без права публикации глава в канал не выйдет.',
      ].join('\n'),
      inline: ACTIONS,
    },
  ];
}

export function telegramRights(botUsername: string): [TelegramOutgoing] {
  const bot = botUsername.replace(/^@/, '');
  return [{
    text: [
      `Как выдать права @${bot}.`,
      '',
      'Откройте канал. Нажмите его название, затем «Администраторы» и «Добавить администратора».',
      `В поиске найдите @${bot} и откройте его.`,
      'Включите только это:',
      '• Публикация сообщений — без него пост не выйдет.',
      '• Изменение сообщений — чтобы правка главы обновила пост.',
      '• Удаление сообщений — чтобы снятие главы убрало пост.',
      'Остальные переключатели оставьте выключенными и сохраните.',
      'Вернитесь в этот чат и нажмите «Проверить канал».',
    ].join('\n'),
    inline: ACTIONS,
  }];
}

export function telegramNeedChannel(): TelegramOutgoing[] {
  return [
    { text: 'Кнопка внизу выбирает канал.', pickChannel: true },
    {
      text: 'Канал ещё не выбран. Нажмите «Выбрать канал» внизу. Если кнопки не видно, нажмите значок клавиатуры справа от поля ввода.',
      inline: ACTIONS,
    },
  ];
}

export function telegramMissingRights(botUsername: string, missing: string[]): TelegramOutgoing[] {
  const bot = botUsername.replace(/^@/, '');
  const list = missing.length > 0 ? missing.join(', ') : 'публикация сообщений, изменение сообщений, удаление сообщений';
  return [{
    text: [
      `Боту @${bot} не хватает прав: ${list}.`,
      '',
      'Откройте канал → Администраторы → этот бот. Включите недостающее и снова нажмите «Проверить канал».',
    ].join('\n'),
    inline: ACTIONS,
  }];
}

export function telegramChannelReady(title: string): TelegramOutgoing[] {
  return [{
    text: `Канал «${title}» подключён. Новые главы будут выходить сюда. «Отключить канал» отвязывает канал и не удаляет уже вышедшие посты.`,
    inline: ACTIONS,
  }];
}

export function telegramChannelOff(): TelegramOutgoing[] {
  return [{
    text: 'Канал отключён. Аккаунт Telegram остаётся. «Выбрать канал» привяжет другой.',
    inline: ACTIONS,
    pickChannel: true,
  }];
}

/** Хватает ли боту прав выпустить, поправить и снять пост. Создатель канала проходит всегда. */
export function telegramAdminOk(member: unknown): { ok: boolean; missing: string[] } {
  const row = record(member);
  const status = text(row.status, 40);
  if (status === 'creator') return { ok: true, missing: [] };
  const missing = [
    row.can_post_messages === true ? '' : 'публикация сообщений',
    row.can_edit_messages === true ? '' : 'изменение сообщений',
    row.can_delete_messages === true ? '' : 'удаление сообщений',
  ].filter(Boolean);
  if (status !== 'administrator') return { ok: false, missing };
  return { ok: missing.length === 0, missing };
}

function person(row: Record<string, unknown>): { id: number; name: string } {
  const id = whole(row.id);
  const name = named(text(row.first_name, 80) || text(row.username, 80));
  return { id, name };
}

/** Разбирает апдейт Telegram в действие чата. Чужие поля не сохраняет. */
export function telegramEvent(update: unknown): TelegramEvent {
  const row = record(update);
  const empty: TelegramEvent = {
    kind: 'ignore',
    replyChatId: 0,
    telegramUserId: 0,
    name: '',
    code: '',
    callbackId: '',
    sharedChatId: '',
    memberChatId: '',
    memberTitle: '',
    memberStatus: '',
    member: null,
  };
  const member = record(row.my_chat_member);
  if (Object.keys(member).length > 0) {
    const from = person(record(member.from));
    const chat = record(member.chat);
    const next = record(member.new_chat_member);
    return {
      ...empty,
      kind: 'member',
      replyChatId: from.id,
      telegramUserId: from.id,
      name: from.name,
      memberChatId: whole(chat.id) ? String(whole(chat.id)) : '',
      memberTitle: text(chat.title, 120),
      memberStatus: text(next.status, 40),
      member: next,
    };
  }
  const query = record(row.callback_query);
  if (Object.keys(query).length > 0) {
    const from = person(record(query.from));
    const data = text(query.data, 32);
    const kind = data === 'rights' || data === 'check' || data === 'unlink' ? data : 'ignore';
    return {
      ...empty,
      kind,
      replyChatId: from.id,
      telegramUserId: from.id,
      name: from.name,
      callbackId: text(query.id, 80),
    };
  }
  const message = record(row.message);
  const from = person(record(message.from));
  const chat = record(message.chat);
  const replyChatId = whole(chat.id) || from.id;
  const shared = record(message.chat_shared);
  const sharedId = whole(shared.chat_id);
  if (sharedId) {
    return {
      ...empty,
      kind: 'shared',
      replyChatId,
      telegramUserId: from.id,
      name: from.name,
      sharedChatId: String(sharedId),
    };
  }
  const body = text(message.text, 80);
  const start = body.match(/^\/(?:start|channel)(?:@\w+)?(?:\s+(\S+))?$/i);
  if (!start) return { ...empty, replyChatId, telegramUserId: from.id, name: from.name };
  if (/^\/channel(?:@\w+)?(?:\s|$)/i.test(body)) {
    return { ...empty, kind: 'rights', replyChatId, telegramUserId: from.id, name: from.name };
  }
  return {
    ...empty,
    kind: 'start',
    replyChatId,
    telegramUserId: from.id,
    name: from.name,
    code: start[1] ?? '',
  };
}
