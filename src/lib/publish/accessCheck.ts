import { openSecret } from '../ai/secret.js';
import { prisma } from '../prisma.js';
import { listAuthorTodayWorks, authorTodaySessionFromJson } from './authorTodayClient.js';
import { identifyBoosty } from './boostyClient.js';
import { sessionFromJson } from './boostySession.js';
import { readDiscordWebhook } from './discordClient.js';
import { assertKitUrl, isKitPlatform } from './kit.js';
import { connectLitnet, litnetSessionFromJson } from './litnetClient.js';
import { identifySponsr } from './sponsrAuth.js';
import { sponsrSessionFromJson } from './sponsrSession.js';
import { checkTelegramChannel } from './telegramBotClient.js';
import { isVaultPlatform } from './vault.js';
import { connectWattpad } from './wattpadClient.js';
import { wattpadSessionFromJson } from './wattpad.js';

function metaString(meta: unknown, key: string): string {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return '';
  const value = (meta as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : '';
}

async function probeVk(token: string, ownerId: string): Promise<string> {
  if (!/^-?\d{1,20}$/.test(ownerId)) throw new Error('Сначала укажите id стены');
  let res: Response;
  try {
    res = await fetch('https://api.vk.com/method/wall.get', {
      method: 'POST',
      body: new URLSearchParams({
        access_token: token,
        v: '5.199',
        owner_id: ownerId,
        count: '1',
      }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new Error('ВК не ответил');
  }
  const json = await res.json().catch(() => null) as { error?: { error_msg?: unknown } } | null;
  if (json?.error) {
    const message = typeof json.error.error_msg === 'string' ? json.error.error_msg : '';
    throw new Error(message.replace(/\s+/g, ' ').trim().slice(0, 180) || 'ВК не пустил к стене');
  }
  return 'Стена ВК доступна';
}

async function probePage(platform: string, raw: string): Promise<string> {
  if (!isKitPlatform(platform)) throw new Error('Неизвестная площадка');
  const url = assertKitUrl(platform, raw);
  let res: Response;
  try {
    res = await fetch(url, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(15_000) });
  } catch {
    throw new Error('Страница площадки не ответила');
  }
  if (res.status >= 400) throw new Error('Страница площадки не открылась');
  return 'Страница книги отвечает';
}

/** Спрашивает площадку уже сохранённым ключом. Логин и пароль сюда не попадают. */
export async function checkPublishAccess(userId: string, platform: string): Promise<string> {
  if (!isVaultPlatform(platform)) throw new Error('Неизвестная площадка');
  if (platform === 'telegram') return checkTelegramChannel(userId);
  const row = await prisma.publishAccount.findUnique({
    where: { userId_platform: { userId, platform } },
  });
  if (platform === 'patreon' || platform === 'ficbook' || platform === 'rulate') {
    return probePage(platform, metaString(row?.meta, 'bookUrl'));
  }
  if (!row?.secretCipher) throw new Error('Сначала подключите площадку');
  const secret = openSecret(row.secretCipher);
  if (platform === 'vk') return probeVk(secret, metaString(row.meta, 'ownerId'));
  if (platform === 'discord') {
    const channel = await readDiscordWebhook(secret);
    return channel.name ? `Вебхук «${channel.name}» отвечает` : 'Вебхук Discord отвечает';
  }
  if (platform === 'sponsr') {
    const identity = await identifySponsr(sponsrSessionFromJson(secret).sess);
    return identity.name ? `Sponsr узнал ${identity.name}` : 'Sponsr пустил к аккаунту';
  }
  if (platform === 'boosty') {
    const identity = await identifyBoosty(sessionFromJson(secret));
    return identity.name ? `Boosty узнал ${identity.name}` : 'Boosty пустил к аккаунту';
  }
  if (platform === 'author_today') {
    const listed = await listAuthorTodayWorks(authorTodaySessionFromJson(secret));
    return `Author.Today открыл произведения: ${listed.works.length}`;
  }
  if (platform === 'litnet') {
    const identity = await connectLitnet(litnetSessionFromJson(secret));
    return identity.user.name ? `Литнет узнал ${identity.user.name}` : 'Литнет пустил к аккаунту';
  }
  if (platform === 'wattpad') {
    const identity = await connectWattpad(wattpadSessionFromJson(secret));
    return identity.user.name ? `Wattpad узнал ${identity.user.name}` : 'Wattpad пустил к аккаунту';
  }
  throw new Error('Неизвестная площадка');
}
