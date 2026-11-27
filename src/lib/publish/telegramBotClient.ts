import { env } from '../env.js';
import { prisma } from '../prisma.js';
import { sealSecret, secretHint } from '../ai/secret.js';
import { toJson } from '../access.js';
import {
  telegramAdminOk,
  telegramChannelKeyboard,
  telegramChannelOff,
  telegramChannelReady,
  telegramClosed,
  telegramEvent,
  telegramInviteCode,
  telegramInviteHash,
  telegramLinked,
  telegramMissingRights,
  telegramNeedChannel,
  telegramRights,
  telegramStale,
  type TelegramOutgoing,
} from './telegramBot.js';

interface BotMe {
  id: number;
  username: string;
}

interface LinkedAccount {
  id: string;
  userId: string;
  meta: Record<string, unknown>;
}

let cachedMe: BotMe | null = null;
let pollController: AbortController | null = null;

function metaOf(meta: unknown): Record<string, unknown> {
  return meta && typeof meta === 'object' && !Array.isArray(meta) ? { ...meta as Record<string, unknown> } : {};
}

function metaText(meta: Record<string, unknown>, key: string): string {
  const value = meta[key];
  return typeof value === 'string' ? value : '';
}

function safe(err: unknown): string {
  const text = err instanceof Error ? err.message : 'Telegram не ответил';
  return text.replace(/bot\d+:[A-Za-z0-9_-]+/gi, 'bot').replace(/\s+/g, ' ').trim().slice(0, 200);
}

async function api(method: string, body?: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
  const token = env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('Бот Telegram не настроен');
  let res: Response;
  try {
    res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
      signal: signal ?? AbortSignal.timeout(20_000),
    });
  } catch (err) {
    if (signal?.aborted) throw err;
    throw new Error('Telegram не ответил');
  }
  let json: { ok?: boolean; description?: unknown; result?: unknown } = {};
  try {
    json = await res.json() as { ok?: boolean; description?: unknown; result?: unknown };
  } catch {
    json = {};
  }
  if (!res.ok || json.ok === false) throw new Error(safe(json.description ?? 'Telegram отклонил запрос'));
  return json.result;
}

export async function telegramMe(): Promise<BotMe> {
  if (cachedMe) return cachedMe;
  const result = apiRecord(await api('getMe'));
  const id = typeof result.id === 'number' ? result.id : 0;
  const username = typeof result.username === 'string' ? result.username : '';
  if (!id || !username) throw new Error('Telegram не назвал бота');
  cachedMe = { id, username };
  return cachedMe;
}

function apiRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

async function botAccounts(): Promise<LinkedAccount[]> {
  const rows = await prisma.publishAccount.findMany({
    where: { platform: 'telegram' },
    select: { id: true, userId: true, meta: true },
  });
  return rows
    .map((row) => ({ id: row.id, userId: row.userId, meta: metaOf(row.meta) }))
    .filter((row) => row.meta.via === 'bot');
}

async function saveMeta(account: LinkedAccount, meta: Record<string, unknown>, label: string) {
  await prisma.publishAccount.update({
    where: { id: account.id },
    data: { meta: toJson(meta), label: label.slice(0, 80) || 'Telegram' },
  });
  account.meta = meta;
}

async function say(chatId: number, messages: TelegramOutgoing[]) {
  if (!chatId) return;
  for (const message of messages) {
    const markup = message.pickChannel
      ? telegramChannelKeyboard()
      : message.inline
        ? { inline_keyboard: message.inline }
        : undefined;
    await api('sendMessage', {
      chat_id: chatId,
      text: message.text,
      ...(markup ? { reply_markup: markup } : {}),
    });
  }
}

async function channelState(chatId: string): Promise<{ title: string; ok: boolean; missing: string[] }> {
  const me = await telegramMe();
  const chat = apiRecord(await api('getChat', { chat_id: chatId }));
  const title = typeof chat.title === 'string' && chat.title.trim()
    ? chat.title.trim().slice(0, 120)
    : typeof chat.username === 'string' && chat.username
      ? `@${chat.username}`
      : 'канал';
  const member = await api('getChatMember', { chat_id: chatId, user_id: me.id });
  const rights = telegramAdminOk(member);
  return { title, ok: rights.ok, missing: rights.missing };
}

async function rememberChannel(account: LinkedAccount, chatId: string, replyChatId: number) {
  const me = await telegramMe();
  let state: { title: string; ok: boolean; missing: string[] };
  try {
    state = await channelState(chatId);
  } catch {
    await say(replyChatId, telegramMissingRights(me.username, []));
    return;
  }
  if (!state.ok) {
    await say(replyChatId, telegramMissingRights(me.username, state.missing));
    return;
  }
  const meta = {
    ...account.meta,
    via: 'bot',
    chatId,
    chatTitle: state.title,
  };
  await saveMeta(account, meta, state.title);
  await say(replyChatId, telegramChannelReady(state.title));
}

async function accountByUser(telegramUserId: number): Promise<LinkedAccount | null> {
  const rows = await botAccounts();
  return rows.find((row) => metaText(row.meta, 'telegramUserId') === String(telegramUserId)) ?? null;
}

export async function createTelegramInvite(userId: string): Promise<{ url: string; expiresAt: string }> {
  if (!env.TELEGRAM_BOT_TOKEN) throw new Error('Бот Telegram не настроен');
  const bot = await telegramMe();
  const code = telegramInviteCode();
  const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
  const existing = await prisma.publishAccount.findUnique({
    where: { userId_platform: { userId, platform: 'telegram' } },
    select: { meta: true, label: true },
  });
  const previous = metaOf(existing?.meta);
  const meta = { ...previous, via: 'bot', inviteHash: telegramInviteHash(code), inviteExpires: expiresAt };
  await prisma.publishAccount.upsert({
    where: { userId_platform: { userId, platform: 'telegram' } },
    create: {
      userId,
      platform: 'telegram',
      label: 'Telegram',
      secretCipher: sealSecret('project-bot'),
      secretHint: secretHint('project-bot'),
      meta: toJson(meta),
    },
    update: {
      secretCipher: sealSecret('project-bot'),
      secretHint: secretHint('project-bot'),
      meta: toJson(meta),
      label: metaText(previous, 'chatTitle') || existing?.label || 'Telegram',
    },
  });
  return { url: `https://t.me/${bot.username}?start=${code}`, expiresAt };
}

/** Живой запрос прав бота в уже выбранном канале. */
export async function checkTelegramChannel(userId: string): Promise<string> {
  const status = await telegramStatus(userId);
  if (!status.configured) throw new Error('Бот Telegram не настроен');
  if (!status.linked) throw new Error('Сначала откройте бота и привяжите аккаунт');
  if (!status.chatId) throw new Error('Канал ещё не выбран');
  const state = await channelState(status.chatId);
  if (!state.ok) throw new Error(`Боту не хватает прав: ${state.missing.join(', ')}`);
  return `Канал «${state.title}» доступен`;
}

export async function telegramStatus(userId: string): Promise<{
  configured: boolean;
  username: string;
  linked: boolean;
  chatId: string;
  chatTitle: string;
}> {
  if (!env.TELEGRAM_BOT_TOKEN) {
    return { configured: false, username: '', linked: false, chatId: '', chatTitle: '' };
  }
  const bot = await telegramMe();
  const row = await prisma.publishAccount.findUnique({
    where: { userId_platform: { userId, platform: 'telegram' } },
    select: { meta: true },
  });
  const meta = metaOf(row?.meta);
  return {
    configured: true,
    username: bot.username,
    linked: meta.via === 'bot' && Boolean(metaText(meta, 'telegramUserId')),
    chatId: metaText(meta, 'chatId'),
    chatTitle: metaText(meta, 'chatTitle'),
  };
}

/** Один апдейт из чата с ботом: ссылка, права, выбор канала. */
export async function handleTelegramUpdate(update: unknown): Promise<void> {
  const event = telegramEvent(update);
  if (event.kind === 'ignore' || !event.telegramUserId) return;
  const me = await telegramMe();
  if (event.callbackId) {
    await api('answerCallbackQuery', { callback_query_id: event.callbackId }).catch(() => undefined);
  }
  if (event.kind === 'start') {
    if (!event.code) {
      const known = await accountByUser(event.telegramUserId);
      await say(event.replyChatId, known ? telegramLinked(me.username) : telegramClosed());
      return;
    }
    const rows = await botAccounts();
    const now = Date.now();
    const account = rows.find((row) => {
      if (metaText(row.meta, 'inviteHash') !== telegramInviteHash(event.code)) return false;
      const expires = Date.parse(metaText(row.meta, 'inviteExpires'));
      return Number.isFinite(expires) && expires > now;
    });
    if (!account) {
      await say(event.replyChatId, telegramStale());
      return;
    }
    const previousUser = metaText(account.meta, 'telegramUserId');
    const switched = previousUser !== '' && previousUser !== String(event.telegramUserId);
    const meta: Record<string, unknown> = {
      ...account.meta,
      via: 'bot',
      telegramUserId: String(event.telegramUserId),
      telegramName: event.name,
      inviteHash: '',
      inviteExpires: '',
    };
    if (switched) {
      delete meta.chatId;
      delete meta.chatTitle;
    }
    await saveMeta(account, meta, switched ? 'Telegram' : metaText(account.meta, 'chatTitle') || 'Telegram');
    await say(event.replyChatId, telegramLinked(me.username));
    return;
  }
  const account = await accountByUser(event.telegramUserId);
  if (!account) {
    await say(event.replyChatId, telegramClosed());
    return;
  }
  if (event.kind === 'rights') {
    await say(event.replyChatId, [{ ...telegramRights(me.username)[0], pickChannel: false }, { text: 'Кнопка внизу выбирает канал.', pickChannel: true }]);
    return;
  }
  if (event.kind === 'unlink') {
    const meta = { ...account.meta };
    delete meta.chatId;
    delete meta.chatTitle;
    await saveMeta(account, meta, 'Telegram');
    await say(event.replyChatId, telegramChannelOff());
    return;
  }
  if (event.kind === 'check') {
    const chatId = metaText(account.meta, 'chatId');
    if (!chatId) {
      await say(event.replyChatId, telegramNeedChannel());
      return;
    }
    await rememberChannel(account, chatId, event.replyChatId);
    return;
  }
  if (event.kind === 'shared' && event.sharedChatId) {
    await rememberChannel(account, event.sharedChatId, event.replyChatId);
    return;
  }
  if (event.kind === 'member' && event.memberChatId) {
    if (event.memberStatus === 'left' || event.memberStatus === 'kicked') {
      if (metaText(account.meta, 'chatId') === event.memberChatId) {
        const meta = { ...account.meta };
        delete meta.chatId;
        delete meta.chatTitle;
        await saveMeta(account, meta, 'Telegram');
        await say(event.replyChatId, telegramChannelOff());
      }
      return;
    }
    const rights = telegramAdminOk(event.member);
    if (!rights.ok) {
      await say(event.replyChatId, telegramMissingRights(me.username, rights.missing));
      return;
    }
    const title = event.memberTitle || 'канал';
    const meta = { ...account.meta, via: 'bot', chatId: event.memberChatId, chatTitle: title };
    await saveMeta(account, meta, title);
    await say(event.replyChatId, telegramChannelReady(title));
  }
}

async function poll(signal: AbortSignal) {
  const me = await telegramMe();
  await api('deleteWebhook', { drop_pending_updates: false }).catch(() => undefined);
  await api('setMyCommands', {
    commands: [
      { command: 'start', description: 'Подключить аккаунт' },
      { command: 'channel', description: 'Как добавить бота в канал' },
    ],
  }).catch((err) => console.error(`telegram commands: ${safe(err)}`));
  console.log(`[telegram] @${me.username} слушает чат`);
  let offset = 0;
  while (!signal.aborted) {
    let updates: unknown[] = [];
    try {
      const result = await api('getUpdates', {
        offset,
        timeout: 25,
        allowed_updates: ['message', 'callback_query', 'my_chat_member'],
      }, AbortSignal.any([signal, AbortSignal.timeout(40_000)]));
      updates = Array.isArray(result) ? result : [];
    } catch (err) {
      if (signal.aborted) return;
      console.error(`telegram: ${safe(err)}`);
      await new Promise((resolve) => setTimeout(resolve, 3000));
      continue;
    }
    for (const update of updates) {
      const row = apiRecord(update);
      const id = typeof row.update_id === 'number' ? row.update_id : 0;
      if (id >= offset) offset = id + 1;
      try {
        await handleTelegramUpdate(update);
      } catch (err) {
        console.error(`telegram update: ${safe(err)}`);
      }
    }
  }
}

/** Опрос Telegram. Без токена ничего не делает. */
export function startTelegramPolling(): { stop: () => void } {
  if (!env.TELEGRAM_BOT_TOKEN) return { stop() {} };
  if (pollController) return { stop() { pollController?.abort(); } };
  const controller = new AbortController();
  pollController = controller;
  void poll(controller.signal).catch((err) => {
    if (!controller.signal.aborted) console.error(`telegram: ${safe(err)}`);
  }).finally(() => {
    if (pollController === controller) pollController = null;
  });
  return { stop() { controller.abort(); } };
}
