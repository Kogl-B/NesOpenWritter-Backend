import { sponsrText, sponsrTitle } from './text.js';

export function sponsrPayload(input: {
  title: string;
  book: string;
  blocks: string[];
  url: string;
  date: string;
}): Record<string, unknown> {
  return {
    date: input.date,
    title: sponsrTitle(input.title, input.book),
    text: sponsrText(input.blocks, input.url),
    is_extended_view: true,
    is_pinned: false,
    is_markdown: false,
    is_notified: false,
  };
}

export function vkParams(input: { token: string; ownerId: string; message: string }): URLSearchParams {
  const owner = Number(input.ownerId);
  const params = new URLSearchParams({
    access_token: input.token,
    v: '5.199',
    owner_id: String(owner),
    message: input.message,
  });
  if (owner < 0) params.set('from_group', '1');
  return params;
}

export function vkUrl(ownerId: string, postId: string): string {
  return `https://vk.com/wall${ownerId}_${postId}`;
}

export function telegramPayload(chatId: string, text: string): { chat_id: string; text: string } {
  return { chat_id: chatId, text };
}

export function telegramUrl(chatId: string, messageId: string): string {
  if (chatId.startsWith('@')) return `https://t.me/${chatId.slice(1)}/${messageId}`;
  if (chatId.startsWith('-100')) return `https://t.me/c/${chatId.slice(4)}/${messageId}`;
  return '';
}

export function discordPayload(text: string): { content: string } {
  return { content: text.replace(/@(everyone|here)/gi, '@\u200b$1') };
}
