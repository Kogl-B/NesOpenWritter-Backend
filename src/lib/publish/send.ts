import { discordPayload, sponsrPayload, telegramPayload, telegramUrl, vkParams, vkUrl } from './payload.js';
import { sponsrFailure } from './sponsrClient.js';

function clip(value: unknown, fallback: string): string {
  const text = typeof value === 'string' ? value : fallback;
  const clean = text.replace(/\s+/g, ' ').trim();
  return (clean || fallback).slice(0, 240);
}

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

function httpsLink(value: unknown): string {
  const url = typeof value === 'string' ? value : '';
  if (!url) return '';
  return url.startsWith('http') ? url : `https://${url}`;
}

export async function postSponsr(apiKey: string, body: Record<string, unknown>): Promise<{ id: string; url: string; editor: string }> {
  let res: Response;
  try {
    res = await fetch('https://sponsr.ru/api/v2/external-api/post', {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'X-API-KEY': apiKey,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new Error('Sponsr не ответил');
  }
  const json = await readJson(res) as { data?: { id?: unknown; url?: unknown; editor?: unknown } } | null;
  if (!res.ok) throw new Error(sponsrFailure(res.status, json));
  const data = json?.data;
  const id = data?.id == null ? '' : String(data.id);
  const url = httpsLink(data?.url);
  if (!id && !url) throw new Error('Sponsr не вернул ссылку на пост');
  return { id, url, editor: httpsLink(data?.editor) };
}

export async function postVk(token: string, ownerId: string, message: string): Promise<{ id: string; url: string }> {
  let res: Response;
  try {
    res = await fetch('https://api.vk.com/method/wall.post', {
      method: 'POST',
      body: vkParams({ token, ownerId, message }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new Error('ВК не ответил');
  }
  const json = await readJson(res) as { error?: { error_msg?: unknown }; response?: { post_id?: unknown } } | null;
  if (json?.error) throw new Error(clip(json.error.error_msg, 'ВК отклонил пост'));
  const postId = json?.response?.post_id;
  if (postId == null) throw new Error('ВК не вернул номер поста');
  const id = String(postId);
  return { id, url: vkUrl(ownerId, id) };
}

export async function postTelegram(token: string, chatId: string, text: string): Promise<{ id: string; url: string }> {
  let res: Response;
  try {
    res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(telegramPayload(chatId, text)),
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new Error('Telegram не ответил');
  }
  const json = await readJson(res) as { ok?: boolean; description?: unknown; result?: { message_id?: unknown } } | null;
  if (!res.ok || json?.ok === false) throw new Error(clip(json?.description, 'Telegram отклонил сообщение'));
  const messageId = json?.result?.message_id;
  if (messageId == null) throw new Error('Telegram не вернул номер сообщения');
  const id = String(messageId);
  return { id, url: telegramUrl(chatId, id) };
}

export async function postDiscord(webhook: string, text: string): Promise<{ id: string; url: string }> {
  const endpoint = webhook.includes('?') ? `${webhook}&wait=true` : `${webhook}?wait=true`;
  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(discordPayload(text)),
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new Error('Discord не ответил');
  }
  if (!res.ok) {
    const json = await readJson(res) as { message?: unknown } | null;
    throw new Error(clip(json?.message, 'Discord отклонил сообщение'));
  }
  const json = await readJson(res) as { id?: unknown } | null;
  return { id: json?.id == null ? '' : String(json.id), url: '' };
}

export { sponsrPayload };
