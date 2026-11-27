import { discordChannel, parseDiscordWebhook } from './discord.js';

export async function readDiscordWebhook(webhook: string): Promise<{ name: string; channelId: string; guildId: string }> {
  const parsed = parseDiscordWebhook(webhook);
  let res: Response;
  try {
    res = await fetch(`https://discord.com/api/webhooks/${parsed.id}/${parsed.token}`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new Error('Discord не ответил');
  }
  if (res.status === 401 || res.status === 404) {
    throw new Error('Discord не узнал вебхук. Создайте его в канале заново.');
  }
  if (!res.ok) throw new Error('Discord не ответил');
  return discordChannel(await res.json());
}
