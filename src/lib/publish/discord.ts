const WEBHOOK = /^https:\/\/(?:discord|discordapp)\.com\/api\/webhooks\/(\d{17,20})\/([A-Za-z0-9_-]{20,120})$/;
const SNOWFLAKE = /^\d{17,20}$/;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function snowflake(value: unknown): string {
  const id = typeof value === 'number' ? String(value) : typeof value === 'string' ? value : '';
  return SNOWFLAKE.test(id) ? id : '';
}

/** Адрес вебхука из настроек канала. Токен наружу не возвращается отдельно от проверки. */
export function parseDiscordWebhook(raw: string): { id: string; token: string } {
  const url = raw.trim().replace(/\/+$/, '');
  if (!url) throw new Error('Вставьте URL вебхука Discord');
  if (url.length > 500 || /\s/.test(url)) throw new Error('Ссылка вебхука Discord выглядит неверно');
  const match = url.match(WEBHOOK);
  if (!match?.[1] || !match[2]) {
    throw new Error('Нужна ссылка вебхука из настроек канала. Приглашение на сервер не подходит.');
  }
  return { id: match[1], token: match[2] };
}

/** Имя вебхука и канал, в который он пишет. Токен из ответа не сохраняется. */
export function discordChannel(json: unknown): { name: string; channelId: string; guildId: string } {
  const row = record(json);
  const name = typeof row.name === 'string' ? row.name.replace(/\s+/g, ' ').trim().slice(0, 80) : '';
  const channelId = snowflake(row.channel_id);
  const guildId = snowflake(row.guild_id);
  if (!name || !channelId || !guildId) throw new Error('Discord не назвал канал');
  return { name, channelId, guildId };
}

export function discordMessageUrl(guildId: string, channelId: string, messageId: string): string {
  if (!snowflake(guildId) || !snowflake(channelId) || !snowflake(messageId)) return '';
  return `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;
}

/** Адрес уже отправленного сообщения вебхука. Токен остаётся только в этом адресе запроса. */
export function discordMessageApi(webhook: string, messageId: string): string {
  const parsed = parseDiscordWebhook(webhook);
  if (!snowflake(messageId)) throw new Error('Discord не нашёл сообщение');
  return `https://discord.com/api/webhooks/${parsed.id}/${parsed.token}/messages/${messageId}`;
}
