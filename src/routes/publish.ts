import { queueAutomaticTimelineAnalysis } from '../lib/timeline/schedule.js';
import type { PublishAccount } from '@prisma/client';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import { toJson } from '../lib/access.js';
import { env } from '../lib/env.js';
import { prisma } from '../lib/prisma.js';
import { openSecret, sealSecret, secretHint } from '../lib/ai/secret.js';
import { parseDiscordWebhook } from '../lib/publish/discord.js';
import { readDiscordWebhook } from '../lib/publish/discordClient.js';
import { editDiscordMessage, postDiscord, postSponsr, postTelegram, postVk } from '../lib/publish/send.js';
import { absoluteUrl, announcement, chapterBlocks, chapterPath, sponsrText, sponsrTitle } from '../lib/publish/text.js';
import { bookIsPublished, chapterIsHidden, revealMetadata } from '../lib/publish/visibility.js';
import { chapterBlocked } from '../lib/geo/policy.js';
import { countryBlocks } from '../lib/geo/request.js';
import { createBoostyPost, identifyBoosty, loginBoosty, updateBoostyPost, uploadBoostyImage } from '../lib/publish/boostyClient.js';
import { loginBoostyInteractive } from '../lib/publish/boostyLogin.js';
import { boostyBlogSlug } from '../lib/publish/boostyPost.js';
import { parseBoostySession, sessionFromJson, sessionJson, type BoostySession } from '../lib/publish/boostySession.js';
import { assertKitUrl, chapterHtml, isKitPlatform, kitPackage } from '../lib/publish/kit.js';
import { plainSponsr, sponsrDocument, sponsrPostBody, type SponsrLevel, type SponsrProject } from '../lib/publish/sponsrClient.js';
import { identifySponsr } from '../lib/publish/sponsrAuth.js';
import { saveSponsrManagePost } from '../lib/publish/sponsrManage.js';
import {
  authorTodaySessionFromJson,
  authorTodaySessionJson,
  AuthorTodayChallenge,
  connectAuthorToday,
  listAuthorTodayWorks,
  loginAuthorToday,
  readAuthorTodayChapter,
  type AuthorTodayIdentity,
  saveAuthorTodayChapter,
  type AuthorTodaySession,
} from '../lib/publish/authorTodayClient.js';
import { connectLitnet, litnetSessionFromJson, litnetSessionJson, readLitnetChapter, saveLitnetChapter } from '../lib/publish/litnetClient.js';
import { connectWattpad, loginWattpad, type WattpadIdentity } from '../lib/publish/wattpadClient.js';
import { createTelegramInvite, telegramStatus } from '../lib/publish/telegramBotClient.js';
import { checkPublishAccess } from '../lib/publish/accessCheck.js';
import { accessError, isVaultPlatform, passwordLoginPlatforms, publicVaultPlatforms, serverVault, vaultBody } from '../lib/publish/vault.js';
import { wattpadSessionFromJson, wattpadSessionJson } from '../lib/publish/wattpad.js';
import { parseSponsrSess, sponsrSessionFromJson, sponsrSessionJson } from '../lib/publish/sponsrSession.js';
import { chapterNotices, publishErrorNotice } from '../lib/notify/drafts.js';
import { writeNotices } from '../lib/notify/deliver.js';

const externalSchema = z.enum(['sponsr', 'vk', 'telegram', 'discord']);
const publishSchema = z.object({
  platforms: z.array(z.enum(['site', 'sponsr', 'vk', 'telegram', 'discord', 'author_today', 'litnet', 'boosty'])).min(1).max(8),
});

const NAMES: Record<string, string> = {
  site: 'Сайт',
  sponsr: 'Sponsr',
  vk: 'ВКонтакте',
  telegram: 'Telegram',
  discord: 'Discord',
  author_today: 'Author.Today',
  litnet: 'Литнет',
  boosty: 'Boosty',
};

function bad(message: string): Error & { statusCode: number } {
  const err = new Error(message) as Error & { statusCode: number };
  err.statusCode = 400;
  return err;
}

function autopostEnabled(settings: unknown): boolean {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return true;
  const autopost = (settings as { autopost?: unknown }).autopost;
  if (!autopost || typeof autopost !== 'object' || Array.isArray(autopost)) return true;
  return (autopost as { enabled?: unknown }).enabled !== false;
}

function metaString(meta: unknown, key: string): string {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return '';
  const value = (meta as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : '';
}

function accountCard(row: {
  id: string;
  platform: string;
  label: string;
  secretHint: string;
  meta: unknown;
  updatedAt: Date;
}) {
  return {
    id: row.id,
    platform: row.platform,
    label: row.label,
    hint: row.secretHint,
    ownerId: row.platform === 'vk' ? metaString(row.meta, 'ownerId') : '',
    chatId: row.platform === 'telegram' ? metaString(row.meta, 'chatId') : '',
    chatTitle: row.platform === 'telegram' ? metaString(row.meta, 'chatTitle') : '',
    telegramName: row.platform === 'telegram' ? metaString(row.meta, 'telegramName') : '',
    bookUrl: metaString(row.meta, 'bookUrl'),
    expiresAt: row.platform === 'sponsr' ? metaString(row.meta, 'expiresAt') : '',
    levelId: row.platform === 'sponsr' ? metaLevel(row.meta) : null,
    levels: row.platform === 'sponsr' ? metaLevels(row.meta) : [],
    projects: row.platform === 'sponsr' || row.platform === 'author_today' || row.platform === 'litnet' || row.platform === 'wattpad' ? metaProjects(row.meta) : [],
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function syncRemoteLinks(userId: string, platform: string, projects: Array<{ id: number; title: string; url: string }>) {
  for (const project of projects) {
    await prisma.publishLink.upsert({
      where: { userId_platform_remoteId: { userId, platform, remoteId: String(project.id) } },
      create: {
        userId,
        platform,
        remoteId: String(project.id),
        remoteTitle: project.title,
        remoteUrl: project.url,
      },
      update: { remoteTitle: project.title, remoteUrl: project.url },
    });
  }
  const links = await prisma.publishLink.findMany({
    where: { userId, platform },
    select: { remoteId: true, projectId: true },
  });
  return new Map(links.map((link) => [link.remoteId, link.projectId]));
}

async function refreshAuthorTodayWorks(row: PublishAccount): Promise<PublishAccount> {
  if (row.platform !== 'author_today' || !row.secretCipher) return row;
  try {
    const session = authorTodaySessionFromJson(openSecret(row.secretCipher));
    const listed = await listAuthorTodayWorks(session);
    const previous = row.meta && typeof row.meta === 'object' && !Array.isArray(row.meta)
      ? row.meta as Record<string, unknown>
      : {};
    const changed = listed.session.token !== session.token || listed.session.loginCookie !== session.loginCookie;
    const updated = await prisma.publishAccount.update({
      where: { id: row.id },
      data: {
        meta: toJson({ ...previous, projects: listed.works }),
        ...(changed ? {
          secretCipher: sealSecret(authorTodaySessionJson(listed.session)),
          secretHint: secretHint(listed.session.token),
        } : {}),
      },
    });
    return updated;
  } catch (err) {
    const message = err instanceof Error ? err.message : '';
    if (!message.includes('Сессия Author.Today закончилась') && !message.includes('не узнал сессию')) return row;
    const owner = await prisma.publishAccount.findUnique({ where: { id: row.id }, select: { userId: true } });
    if (!owner) return row;
    const creds = await savedPassword(owner.userId, 'author_today');
    if (!creds) return row;
    try {
      return await storeAuthorToday(owner.userId, await loginAuthorToday(creds));
    } catch {
      return row;
    }
  }
}

async function storeAuthorToday(userId: string, identity: AuthorTodayIdentity) {
  return prisma.publishAccount.upsert({
    where: { userId_platform: { userId, platform: 'author_today' } },
    create: {
      userId,
      platform: 'author_today',
      label: identity.user.name,
      secretCipher: sealSecret(authorTodaySessionJson(identity.session)),
      secretHint: secretHint(identity.session.token),
      meta: toJson({ projects: identity.works }),
    },
    update: {
      label: identity.user.name,
      secretCipher: sealSecret(authorTodaySessionJson(identity.session)),
      secretHint: secretHint(identity.session.token),
      meta: toJson({ projects: identity.works }),
    },
  });
}

async function storeWattpad(userId: string, identity: WattpadIdentity) {
  const existing = await prisma.publishAccount.findUnique({
    where: { userId_platform: { userId, platform: 'wattpad' } },
    select: { meta: true },
  });
  const previous = existing?.meta && typeof existing.meta === 'object' && !Array.isArray(existing.meta)
    ? existing.meta as Record<string, unknown>
    : {};
  return prisma.publishAccount.upsert({
    where: { userId_platform: { userId, platform: 'wattpad' } },
    create: {
      userId,
      platform: 'wattpad',
      label: identity.user.name,
      secretCipher: sealSecret(wattpadSessionJson(identity.token)),
      secretHint: secretHint(identity.token),
      meta: toJson({ ...previous, projects: identity.stories }),
    },
    update: {
      label: identity.user.name,
      secretCipher: sealSecret(wattpadSessionJson(identity.token)),
      secretHint: secretHint(identity.token),
      meta: toJson({ ...previous, projects: identity.stories }),
    },
  });
}

async function savedPassword(userId: string, platform: string): Promise<{ login: string; password: string } | null> {
  const vault = await prisma.publishVault.findUnique({
    where: { userId_platform: { userId, platform } },
  });
  if (!vault) return null;
  return serverVault(vault.loginSeal, vault.passwordSeal);
}

async function refreshLitnetBooks(row: PublishAccount): Promise<PublishAccount> {
  if (row.platform !== 'litnet' || !row.secretCipher) return row;
  try {
    const token = litnetSessionFromJson(openSecret(row.secretCipher));
    const identity = await connectLitnet(token);
    const previous = row.meta && typeof row.meta === 'object' && !Array.isArray(row.meta)
      ? row.meta as Record<string, unknown>
      : {};
    const updated = await prisma.publishAccount.update({
      where: { id: row.id },
      data: {
        label: identity.user.name,
        meta: toJson({ ...previous, projects: identity.books }),
      },
    });
    return updated;
  } catch {
    return row;
  }
}

async function refreshWattpadStories(row: PublishAccount): Promise<PublishAccount> {
  if (row.platform !== 'wattpad' || !row.secretCipher) return row;
  try {
    const token = wattpadSessionFromJson(openSecret(row.secretCipher));
    const identity = await connectWattpad(token);
    const previous = row.meta && typeof row.meta === 'object' && !Array.isArray(row.meta)
      ? row.meta as Record<string, unknown>
      : {};
    const updated = await prisma.publishAccount.update({
      where: { id: row.id },
      data: {
        label: identity.user.name,
        meta: toJson({ ...previous, projects: identity.stories }),
      },
    });
    return updated;
  } catch (err) {
    const message = err instanceof Error ? err.message : '';
    if (!message.includes('не узнал сессию')) return row;
    const owner = await prisma.publishAccount.findUnique({ where: { id: row.id }, select: { userId: true } });
    if (!owner) return row;
    const creds = await savedPassword(owner.userId, 'wattpad');
    if (!creds) return row;
    try {
      return await storeWattpad(owner.userId, await loginWattpad(creds));
    } catch {
      return row;
    }
  }
}

async function refreshBoostySession(row: PublishAccount): Promise<PublishAccount> {
  if (row.platform !== 'boosty' || !row.secretCipher) return row;
  try {
    const session = sessionFromJson(openSecret(row.secretCipher));
    const identity = await identifyBoosty(session);
    if (sessionJson(identity.session) === sessionJson(session)) return row;
    const updated = await prisma.publishAccount.update({
      where: { id: row.id },
      data: {
        label: identity.name || 'Boosty',
        secretCipher: sealSecret(sessionJson(identity.session)),
        secretHint: secretHint(identity.session.accessToken),
      },
    });
    return updated;
  } catch (err) {
    const message = err instanceof Error ? err.message : '';
    if (!message.includes('не принял сессию') && !message.includes('не обновил сессию')) return row;
    const owner = await prisma.publishAccount.findUnique({ where: { id: row.id }, select: { userId: true } });
    if (!owner) return row;
    const creds = await savedPassword(owner.userId, 'boosty');
    if (!creds) return row;
    try {
      const identity = await loginBoosty(creds);
      const updated = await prisma.publishAccount.update({
        where: { id: row.id },
        data: {
          label: identity.name || 'Boosty',
          secretCipher: sealSecret(sessionJson(identity.session)),
          secretHint: secretHint(identity.session.accessToken),
        },
      });
      return updated;
    } catch {
      return row;
    }
  }
}

async function present(row: {
  id: string;
  userId: string;
  platform: string;
  label: string;
  secretHint: string;
  meta: unknown;
  updatedAt: Date;
}) {
  const card = accountCard(row);
  if (row.platform !== 'sponsr' && row.platform !== 'author_today' && row.platform !== 'litnet' && row.platform !== 'wattpad') return card;
  const links = await syncRemoteLinks(row.userId, row.platform, card.projects);
  return {
    ...card,
    projects: card.projects.map((project) => ({
      ...project,
      projectId: links.get(String(project.id)) ?? null,
    })),
  };
}

async function publishSponsrSession(userId: string, meta: unknown, secret: string, input: {
  remoteId?: number;
  postId?: number;
  title: string;
  html: string;
  notify: boolean;
}) {
  const session = sponsrSessionFromJson(secret);
  const projects = metaProjects(meta);
  const remoteId = input.remoteId ?? (projects.length === 1 ? projects[0]?.id : 0);
  const project = projects.find((item) => item.id === remoteId);
  if (!project) throw new Error('Выберите проект Sponsr');
  const sent = await saveSponsrManagePost(session, {
    project,
    postId: input.postId,
    title: input.title,
    html: input.html,
    notify: input.notify,
  });
  if (sent.sess !== session.sess) {
    await prisma.publishAccount.update({
      where: { userId_platform: { userId, platform: 'sponsr' } },
      data: {
        secretCipher: sealSecret(sponsrSessionJson({ sess: sent.sess, accessToken: session.accessToken })),
        secretHint: secretHint(session.accessToken),
      },
    });
  }
  return { id: String(sent.id), url: sent.url, editor: '' };
}

async function keepAuthorTodaySession(userId: string, previous: AuthorTodaySession, next: AuthorTodaySession) {
  if (next.token === previous.token && next.loginCookie === previous.loginCookie) return;
  await prisma.publishAccount.update({
    where: { userId_platform: { userId, platform: 'author_today' } },
    data: {
      secretCipher: sealSecret(authorTodaySessionJson(next)),
      secretHint: secretHint(next.token),
    },
  });
}

async function saveAuthorTodayFromAccount(userId: string, secret: string, input: {
  workId: number;
  chapterId?: number;
  title: string;
  html: string;
  draft: boolean;
}) {
  const session = authorTodaySessionFromJson(secret);
  const sent = await saveAuthorTodayChapter(session, input);
  await keepAuthorTodaySession(userId, session, sent.session);
  return sent;
}

async function publishAuthorTodayChapter(userId: string, secret: string, projectId: string, title: string, html: string, remoteChapterId?: number) {
  const links = await prisma.publishLink.findMany({
    where: { userId, platform: 'author_today', projectId },
    select: { remoteId: true },
  });
  if (links.length === 0) throw new Error('Сопоставьте произведение Author.Today с этой книгой на странице «Автопост».');
  if (links.length > 1) throw new Error('С этой книгой сопоставлено несколько произведений Author.Today. Оставьте одно.');
  const workId = Number(links[0]?.remoteId);
  if (!Number.isInteger(workId) || workId <= 0) throw new Error('Произведение Author.Today не найдено');
  let chapterId = remoteChapterId;
  if (chapterId) {
    const session = authorTodaySessionFromJson(secret);
    const found = await readAuthorTodayChapter(session, chapterId);
    await keepAuthorTodaySession(userId, session, found.session);
    if (!found.chapter || found.chapter.workId !== workId) chapterId = undefined;
  }
  return saveAuthorTodayFromAccount(userId, secret, { workId, chapterId, title: title.trim() || 'Глава', html, draft: false });
}

async function publishLitnetChapter(secret: string, projectId: string, userId: string, title: string, html: string, remoteChapterId?: number) {
  const links = await prisma.publishLink.findMany({
    where: { userId, platform: 'litnet', projectId },
    select: { remoteId: true },
  });
  if (links.length === 0) throw new Error('Сопоставьте книгу Литнета с этой книгой на странице «Автопост».');
  if (links.length > 1) throw new Error('С этой книгой сопоставлено несколько книг Литнета. Оставьте одну.');
  const bookId = Number(links[0]?.remoteId);
  if (!Number.isInteger(bookId) || bookId <= 0) throw new Error('Книга Литнета не найдена');
  const token = litnetSessionFromJson(openSecret(secret));
  let chapterId = remoteChapterId;
  if (chapterId) {
    const found = await readLitnetChapter(token, chapterId);
    if (!found || found.bookId !== bookId) chapterId = undefined;
  }
  return saveLitnetChapter(token, { bookId, chapterId, title: title.trim() || 'Глава', html, draft: false });
}

async function latestRemoteId(userId: string, chapterId: string, platform: string): Promise<string> {
  const previous = await prisma.publishDelivery.findFirst({
    where: { userId, chapterId, platform, status: 'ok' },
    orderBy: { createdAt: 'desc' },
    select: { remoteId: true },
  });
  return previous?.remoteId ?? '';
}

async function publishSponsrChapter(userId: string, secret: string, meta: unknown, projectId: string, book: string, title: string, html: string, url: string, remotePostId?: number) {
  const links = await prisma.publishLink.findMany({
    where: { userId, platform: 'sponsr', projectId },
    select: { remoteId: true },
  });
  if (links.length === 0) throw new Error('Сопоставьте проект Sponsr с этой книгой на странице «Автопост».');
  if (links.length > 1) throw new Error('С этой книгой сопоставлено несколько проектов Sponsr. Оставьте один.');
  const remoteId = Number(links[0]?.remoteId);
  if (!Number.isInteger(remoteId) || remoteId <= 0) throw new Error('Проект Sponsr не найден');
  return publishSponsrSession(userId, meta, secret, {
    remoteId,
    postId: remotePostId,
    title: sponsrTitle(title, book),
    html: sponsrDocument({ body: html, url }),
    notify: false,
  });
}

function metaLevel(meta: unknown): number | null {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return null;
  const value = (meta as { levelId?: unknown }).levelId;
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

function metaLevels(meta: unknown): SponsrLevel[] {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return [];
  const list = (meta as { levels?: unknown }).levels;
  if (!Array.isArray(list)) return [];
  const levels: SponsrLevel[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const row = item as { id?: unknown; name?: unknown };
    if (typeof row.id !== 'number' || typeof row.name !== 'string') continue;
    levels.push({ id: row.id, name: row.name });
  }
  return levels;
}

function metaProjects(meta: unknown): SponsrProject[] {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return [];
  const list = (meta as { projects?: unknown }).projects;
  if (!Array.isArray(list)) return [];
  const projects: SponsrProject[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const row = item as { id?: unknown; title?: unknown; url?: unknown };
    if (typeof row.id !== 'number' || typeof row.title !== 'string' || typeof row.url !== 'string') continue;
    const ownSite = row.url === ''
      || row.url.startsWith('https://sponsr.ru/')
      || row.url.startsWith('https://author.today/work/')
      || row.url.startsWith('https://litnet.com/ru/book/')
      || row.url.startsWith('https://litnet.com/account/novels/view?id=')
      || row.url.startsWith('https://www.wattpad.com/story/')
      || row.url.startsWith('https://wattpad.com/story/');
    if (!ownSite) continue;
    const role = typeof (row as { role?: unknown }).role === 'string' ? (row as { role: string }).role : '';
    projects.push({ id: row.id, title: row.title, url: row.url, ...(role ? { role } : {}) });
  }
  return projects;
}

function connectionOf(input: {
  platform: z.infer<typeof externalSchema>;
  label?: string;
  secret: string;
  ownerId?: string;
  chatId?: string;
}): { label: string; secret: string; meta: Record<string, string> } {
  const secret = input.secret.trim();
  if (secret.length < 8 || secret.length > 500 || /\s/.test(secret)) {
    throw bad('Ключ площадки выглядит неверно');
  }
  const label = (input.label ?? '').trim().slice(0, 80) || NAMES[input.platform] || input.platform;
  if (input.platform === 'discord') parseDiscordWebhook(secret);
  if (input.platform === 'vk') {
    const ownerId = (input.ownerId ?? '').trim();
    if (!/^-?\d{1,20}$/.test(ownerId) || ownerId === '0' || ownerId === '-0') {
      throw bad('Укажите id стены ВК: число, для сообщества — со знаком минус');
    }
    return { label, secret, meta: { ownerId } };
  }
  if (input.platform === 'telegram') {
    const chatId = (input.chatId ?? '').trim();
    if (!/^-?\d{1,20}$/.test(chatId) && !/^@[A-Za-z][A-Za-z0-9_]{3,31}$/.test(chatId)) {
      throw bad('Укажите id чата Telegram или @имя канала');
    }
    return { label, secret, meta: { chatId } };
  }
  return { label, secret, meta: {} };
}

function failureText(err: unknown): string {
  const message = err instanceof Error ? err.message : '';
  if (message.includes('повреждён')) return 'Ключ площадки повреждён. Подключите её заново.';
  const clean = message.replace(/\s+/g, ' ').trim();
  return (clean || 'Не удалось опубликовать').slice(0, 240);
}

const boostyPostBody = z.object({
  title: z.string().trim().min(1).max(200),
  text: z.string().max(100_000).default(''),
  links: z.array(z.object({
    url: z.string().trim().max(500),
    title: z.string().trim().max(200).optional(),
  })).max(10).default([]),
  images: z.array(z.object({
    id: z.string().trim().max(80),
    url: z.string().trim().max(500),
    width: z.number().int().min(0).max(20_000),
    height: z.number().int().min(0).max(20_000),
    size: z.number().int().min(0).max(20_000_000),
  })).max(10).default([]),
}).refine((value) => value.text.trim().length > 0 || value.links.length > 0 || value.images.length > 0, {
  message: 'empty',
});

export const publishRoutes: FastifyPluginAsync = async (app) => {
  app.addContentTypeParser(/^image\/(jpeg|png|webp|gif)$/i, { parseAs: 'buffer', bodyLimit: 8 * 1024 * 1024 }, (_req, body, done) => {
    done(null, body);
  });
  app.get('/api/publish/accounts', async (req) => {
    app.requireAuth(req);
    const rows = await prisma.publishAccount.findMany({
      where: { userId: req.user!.id },
      orderBy: { platform: 'asc' },
    });
    const fresh = await Promise.all(rows.map(async (row) => refreshBoostySession(await refreshWattpadStories(await refreshLitnetBooks(await refreshAuthorTodayWorks(row))))));
    const vaults = await prisma.publishVault.findMany({
      where: { userId: req.user!.id },
      select: { platform: true, loginSeal: true, passwordSeal: true },
    });
    return {
      accounts: await Promise.all(fresh.map((row) => present(row))),
      vaults: publicVaultPlatforms(vaults),
      passwordLogins: passwordLoginPlatforms(vaults),
    };
  });

  app.post('/api/publish/vault', async (req, reply) => {
    app.requireAuth(req);
    // Шифр пишется как есть. Открытого логина и пароля в этом запросе нет.
    const parsed = vaultBody.safeParse(req.body);
    if (!parsed.success || !isVaultPlatform(parsed.data.platform)) {
      return reply.status(400).send({ error: 'Вход принимается только шифром из браузера' });
    }
    const { platform, loginSeal, passwordSeal } = parsed.data;
    await prisma.publishVault.upsert({
      where: { userId_platform: { userId: req.user!.id, platform } },
      create: {
        userId: req.user!.id,
        platform,
        loginSeal,
        passwordSeal,
      },
      update: {
        loginSeal,
        passwordSeal,
      },
    });
    return { ok: true as const };
  });

  app.get<{ Params: { platform: string } }>('/api/publish/vault/:platform', async (req, reply) => {
    app.requireAuth(req);
    if (!isVaultPlatform(req.params.platform)) return reply.status(404).send({ error: 'Площадка не найдена' });
    const row = await prisma.publishVault.findUnique({
      where: { userId_platform: { userId: req.user!.id, platform: req.params.platform } },
      select: { loginSeal: true, passwordSeal: true },
    });
    if (!row || publicVaultPlatforms([{ platform: req.params.platform, ...row }]).length === 0) {
      return reply.status(404).send({ error: 'Сохранённого входа нет' });
    }
    return { loginSeal: row.loginSeal, passwordSeal: row.passwordSeal };
  });

  app.post('/api/publish/access', async (req, reply) => {
    app.requireAuth(req);
    const parsed = z.object({ platform: z.string() }).safeParse(req.body);
    if (!parsed.success || !isVaultPlatform(parsed.data.platform)) {
      return reply.status(400).send({ error: 'Неизвестная площадка' });
    }
    try {
      return { ok: true as const, message: await checkPublishAccess(req.user!.id, parsed.data.platform) };
    } catch (err) {
      return reply.status(400).send({ error: accessError(err) });
    }
  });

  app.post('/api/publish/accounts', async (req, reply) => {
    app.requireAuth(req);
    const parsed = z.object({
      platform: externalSchema,
      label: z.string().max(80).optional(),
      secret: z.string(),
      ownerId: z.string().max(24).optional(),
      chatId: z.string().max(40).optional(),
    }).safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: 'Проверьте поля площадки' });
    let connection: ReturnType<typeof connectionOf>;
    try {
      connection = connectionOf(parsed.data);
    } catch (err) {
      return reply.status(400).send({ error: err instanceof Error ? err.message : 'Проверьте поля площадки' });
    }
    if (parsed.data.platform === 'sponsr') {
      return reply.status(400).send({ error: 'Sponsr подключается сессией из браузера, не ключом API' });
    }
    if (parsed.data.platform === 'discord') {
      try {
        const channel = await readDiscordWebhook(connection.secret);
        connection = {
          ...connection,
          label: channel.name,
          meta: { channelId: channel.channelId, guildId: channel.guildId },
        };
      } catch (err) {
        return reply.status(400).send({ error: err instanceof Error ? err.message : 'Discord не принял вебхук' });
      }
    }
    const row = await prisma.publishAccount.upsert({
      where: { userId_platform: { userId: req.user!.id, platform: parsed.data.platform } },
      create: {
        userId: req.user!.id,
        platform: parsed.data.platform,
        label: connection.label,
        secretCipher: sealSecret(connection.secret),
        secretHint: secretHint(connection.secret),
        meta: toJson(connection.meta),
      },
      update: {
        label: connection.label,
        secretCipher: sealSecret(connection.secret),
        secretHint: secretHint(connection.secret),
        meta: toJson(connection.meta),
      },
    });
    return { account: await present(row) };
  });

  app.delete<{ Params: { id: string } }>('/api/publish/accounts/:id', async (req, reply) => {
    app.requireAuth(req);
    const row = await prisma.publishAccount.findFirst({
      where: { id: req.params.id, userId: req.user!.id },
      select: { id: true },
    });
    if (!row) return reply.status(404).send({ error: 'Площадка не найдена' });
    await prisma.publishAccount.delete({ where: { id: row.id } });
    return { ok: true as const };
  });

  app.post('/api/publish/kits', async (req, reply) => {
    app.requireAuth(req);
    const parsed = z.object({
      platform: z.string(),
      bookUrl: z.string().max(500),
    }).safeParse(req.body);
    if (!parsed.success || !isKitPlatform(parsed.data.platform)) {
      return reply.status(400).send({ error: 'Неизвестная площадка' });
    }
    const bookUrl = parsed.data.bookUrl.trim();
    if (!bookUrl) {
      await prisma.publishAccount.deleteMany({
        where: { userId: req.user!.id, platform: parsed.data.platform },
      });
      return { ok: true as const };
    }
    let safeUrl: string;
    try {
      safeUrl = assertKitUrl(parsed.data.platform, bookUrl);
    } catch (err) {
      return reply.status(400).send({ error: err instanceof Error ? err.message : 'Адрес не подходит' });
    }
    const row = await prisma.publishAccount.upsert({
      where: { userId_platform: { userId: req.user!.id, platform: parsed.data.platform } },
      create: {
        userId: req.user!.id,
        platform: parsed.data.platform,
        label: parsed.data.platform,
        secretCipher: '',
        secretHint: '',
        meta: toJson({ bookUrl: safeUrl }),
      },
      update: { meta: toJson({ bookUrl: safeUrl }) },
    });
    return { account: await present(row) };
  });

  async function storeBoostySession(userId: string, session: BoostySession) {
    const identity = await identifyBoosty(session);
    const previous = await prisma.publishAccount.findUnique({
      where: { userId_platform: { userId, platform: 'boosty' } },
      select: { meta: true },
    });
    const bookUrl = identity.blogUrl || metaString(previous?.meta, 'bookUrl');
    const row = await prisma.publishAccount.upsert({
      where: { userId_platform: { userId, platform: 'boosty' } },
      create: {
        userId,
        platform: 'boosty',
        label: identity.name || 'Boosty',
        secretCipher: sealSecret(sessionJson(identity.session)),
        secretHint: secretHint(identity.session.accessToken),
        meta: toJson({ bookUrl }),
      },
      update: {
        label: identity.name || 'Boosty',
        secretCipher: sealSecret(sessionJson(identity.session)),
        secretHint: secretHint(identity.session.accessToken),
        meta: toJson({ bookUrl }),
      },
    });
    return { account: await present(row) };
  }

  async function storeSponsrSession(userId: string, sess: string) {
    const identity = await identifySponsr(sess);
    const row = await prisma.publishAccount.upsert({
      where: { userId_platform: { userId, platform: 'sponsr' } },
      create: {
        userId,
        platform: 'sponsr',
        label: identity.name || 'Sponsr',
        secretCipher: sealSecret(sponsrSessionJson(identity.session)),
        secretHint: secretHint(identity.session.accessToken),
        meta: toJson({ projects: identity.projects }),
      },
      update: {
        label: identity.name || 'Sponsr',
        secretCipher: sealSecret(sponsrSessionJson(identity.session)),
        secretHint: secretHint(identity.session.accessToken),
        meta: toJson({ projects: identity.projects }),
      },
    });
    return { account: await present(row) };
  }

  app.post('/api/publish/sponsr/session', async (req, reply) => {
    app.requireAuth(req);
    const parsed = z.object({ paste: z.string().max(20_000) }).safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: 'Вставьте сессию Sponsr' });
    let sess: string;
    try {
      sess = parseSponsrSess(parsed.data.paste);
    } catch (err) {
      return reply.status(400).send({ error: err instanceof Error ? err.message : 'Сессия Sponsr не читается' });
    }
    try {
      return await storeSponsrSession(req.user!.id, sess);
    } catch (err) {
      return reply.status(400).send({ error: err instanceof Error ? err.message : 'Sponsr не принял сессию' });
    }
  });

  app.post('/api/publish/boosty', async (req, reply) => {
    app.requireAuth(req);
    const parsed = z.object({ paste: z.string().max(20_000) }).safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: 'Вставьте сессию Boosty' });
    let session;
    try {
      session = parseBoostySession(parsed.data.paste);
    } catch (err) {
      return reply.status(400).send({ error: err instanceof Error ? err.message : 'Сессия Boosty не читается' });
    }
    try {
      return await storeBoostySession(req.user!.id, session);
    } catch (err) {
      return reply.status(400).send({ error: err instanceof Error ? err.message : 'Boosty не принял сессию' });
    }
  });

  async function openBoosty(userId: string) {
    const account = await prisma.publishAccount.findUnique({
      where: { userId_platform: { userId, platform: 'boosty' } },
    });
    if (!account?.secretCipher) throw new Error('Сначала подключите Boosty');
    return {
      account,
      session: sessionFromJson(openSecret(account.secretCipher)),
      blog: boostyBlogSlug(metaString(account.meta, 'bookUrl')),
    };
  }

  async function keepBoostySession(accountId: string, before: BoostySession, after: BoostySession) {
    if (sessionJson(before) === sessionJson(after)) return;
    await prisma.publishAccount.update({
      where: { id: accountId },
      data: {
        secretCipher: sealSecret(sessionJson(after)),
        secretHint: secretHint(after.accessToken),
      },
    });
  }

  function boostyCard(post: { id: string; url: string; title: string; published: boolean }) {
    return { id: post.id, url: post.url, title: post.title, published: post.published };
  }

  app.post('/api/publish/boosty/image', async (req, reply) => {
    app.requireAuth(req);
    if (!Buffer.isBuffer(req.body)) return reply.status(400).send({ error: 'Пришлите файл фото' });
    const type = String(req.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
    try {
      const opened = await openBoosty(req.user!.id);
      const uploaded = await uploadBoostyImage(opened.session, { bytes: req.body, type }, opened.blog);
      await keepBoostySession(opened.account.id, opened.session, uploaded.session);
      return { image: uploaded.image };
    } catch (err) {
      return reply.status(400).send({ error: err instanceof Error ? err.message : 'Boosty не принял фото' });
    }
  });

  app.post('/api/publish/boosty/post', async (req, reply) => {
    app.requireAuth(req);
    const parsed = boostyPostBody.safeParse(req.body ?? {});
    if (!parsed.success) return reply.status(400).send({ error: 'Укажите заголовок и содержимое поста' });
    try {
      const opened = await openBoosty(req.user!.id);
      const created = await createBoostyPost(opened.session, opened.blog, {
        title: parsed.data.title,
        paragraphs: parsed.data.text.split(/\n+/),
        links: parsed.data.links,
        images: parsed.data.images,
      });
      await keepBoostySession(opened.account.id, opened.session, created.session);
      return boostyCard(created.post);
    } catch (err) {
      return reply.status(400).send({ error: err instanceof Error ? err.message : 'Boosty не создал пост' });
    }
  });

  app.put<{ Params: { postId: string } }>('/api/publish/boosty/post/:postId', async (req, reply) => {
    app.requireAuth(req);
    const parsed = boostyPostBody.safeParse(req.body ?? {});
    if (!parsed.success) return reply.status(400).send({ error: 'Укажите заголовок и содержимое поста' });
    try {
      const opened = await openBoosty(req.user!.id);
      const updated = await updateBoostyPost(opened.session, opened.blog, req.params.postId, {
        title: parsed.data.title,
        paragraphs: parsed.data.text.split(/\n+/),
        links: parsed.data.links,
        images: parsed.data.images,
      });
      await keepBoostySession(opened.account.id, opened.session, updated.session);
      return boostyCard(updated.post);
    } catch (err) {
      return reply.status(400).send({ error: err instanceof Error ? err.message : 'Boosty не изменил пост' });
    }
  });

  app.post('/api/publish/boosty/login', async (req, reply) => {
    app.requireAuth(req);
    const ac = new AbortController();
    const stop = () => ac.abort();
    req.raw.on('aborted', stop);
    try {
      const session = await loginBoostyInteractive(ac.signal);
      return await storeBoostySession(req.user!.id, session);
    } catch (err) {
      return reply.status(400).send({ error: err instanceof Error ? err.message : 'Не удалось войти в Boosty' });
    } finally {
      req.raw.removeListener('aborted', stop);
    }
  });

  app.get<{ Params: { chapterId: string }; Querystring: { platform?: string } }>(
    '/api/publish/chapters/:chapterId/kit',
    async (req, reply) => {
      app.requireAuth(req);
      const platform = req.query.platform ?? '';
      if (!isKitPlatform(platform)) return reply.status(400).send({ error: 'Неизвестная площадка' });
      const chapter = await loadOwnChapter(req.params.chapterId, req.user!.id);
      if (!chapter) return reply.status(404).send({ error: 'Глава не найдена' });
      const saved = await prisma.publishAccount.findUnique({
        where: { userId_platform: { userId: req.user!.id, platform } },
        select: { meta: true },
      });
      let openBook = metaString(saved?.meta, 'bookUrl');
      try {
        if (openBook) openBook = assertKitUrl(platform, openBook);
      } catch {
        openBook = '';
      }
      return kitPackage({
        platform,
        title: chapter.title,
        doc: chapter.content,
        bookUrl: openBook,
      });
    },
  );

  app.post<{ Params: { chapterId: string } }>('/api/publish/chapters/:chapterId/kit-link', async (req, reply) => {
    app.requireAuth(req);
    const parsed = z.object({
      platform: z.string(),
      url: z.string().max(500),
    }).safeParse(req.body);
    if (!parsed.success || !isKitPlatform(parsed.data.platform)) {
      return reply.status(400).send({ error: 'Неизвестная площадка' });
    }
    const chapter = await loadOwnChapter(req.params.chapterId, req.user!.id);
    if (!chapter) return reply.status(404).send({ error: 'Глава не найдена' });
    let remoteUrl: string;
    try {
      remoteUrl = assertKitUrl(parsed.data.platform, parsed.data.url);
    } catch (err) {
      return reply.status(400).send({ error: err instanceof Error ? err.message : 'Адрес не подходит' });
    }
    await prisma.publishDelivery.create({
      data: {
        userId: req.user!.id,
        chapterId: chapter.id,
        projectId: chapter.projectId,
        platform: parsed.data.platform,
        status: 'ok',
        remoteUrl,
      },
    });
    return { platform: parsed.data.platform, status: 'ok' as const, url: remoteUrl, error: '' };
  });

  app.get<{ Params: { chapterId: string } }>('/api/publish/chapters/:chapterId/preview', async (req, reply) => {
    app.requireAuth(req);
    const chapter = await loadOwnChapter(req.params.chapterId, req.user!.id);
    if (!chapter) return reply.status(404).send({ error: 'Глава не найдена' });
    const published = bookIsPublished(chapter.project.settings);
    const url = published ? absoluteUrl(env.FRONTEND_URL, chapterPath(chapter.projectId, chapter.id)) : '';
    return {
      bookPublished: published,
      url,
      announcement: draft(chapter, url),
    };
  });

  app.post<{ Params: { chapterId: string } }>('/api/publish/chapters/:chapterId', async (req, reply) => {
    app.requireAuth(req);
    const parsed = publishSchema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: 'Выберите площадку' });
    const chapter = await loadOwnChapter(req.params.chapterId, req.user!.id);
    if (!chapter) return reply.status(404).send({ error: 'Глава не найдена' });
    const owner = await prisma.user.findUnique({ where: { id: req.user!.id }, select: { settings: true } });
    if (!autopostEnabled(owner?.settings)) {
      return reply.status(400).send({ error: 'Автопубликация выключена. Включите её на странице «Автопост».' });
    }
    if (!bookIsPublished(chapter.project.settings)) {
      return reply.status(400).send({ error: 'Сначала опубликуйте книгу на сайте: в списке проектов кнопка «На сайт».' });
    }
    const platforms = [...new Set(parsed.data.platforms)];
    if (chapterIsHidden(chapter.metadata) && !platforms.includes('site')) {
      return reply.status(400).send({ error: 'Глава скрыта. Отметьте площадку «Сайт», чтобы выпустить её.' });
    }
    const wanted = platforms.filter((platform) => platform !== 'site');
    const accounts = wanted.length === 0
      ? []
      : await prisma.publishAccount.findMany({
        where: { userId: req.user!.id, platform: { in: wanted } },
      });
    const missing = wanted.filter((platform) => !accounts.some((row) => row.platform === platform));
    if (missing.length > 0) {
      return reply.status(400).send({ error: `Сначала подключите: ${missing.map((platform) => NAMES[platform] ?? platform).join(', ')}` });
    }

    return { deliveries: await pushPublishedChapter(req.user!.id, chapter, platforms) };
  });

  async function pushPublishedChapter(
    userId: string,
    chapter: NonNullable<Awaited<ReturnType<typeof loadOwnChapter>>>,
    platforms: string[],
  ) {
    const url = absoluteUrl(env.FRONTEND_URL, chapterPath(chapter.projectId, chapter.id));
    const blocks = chapterBlocks(chapter.content);
    const text = draft(chapter, url);
    const deliveries: Array<{ platform: string; status: 'ok' | 'error'; url: string; error: string }> = [];
    const external = platforms.filter((platform) => platform !== 'site');
    const accounts = external.length === 0
      ? []
      : await prisma.publishAccount.findMany({
        where: { userId, platform: { in: external } },
      });

    const write = async (input: { platform: string; status: 'ok' | 'error'; remoteId?: string; remoteUrl?: string; error?: string }) => {
      const row = await prisma.publishDelivery.create({
        data: {
          userId: userId,
          chapterId: chapter.id,
          projectId: chapter.projectId,
          platform: input.platform,
          status: input.status,
          remoteId: input.remoteId ?? '',
          remoteUrl: input.remoteUrl ?? '',
          error: input.error ?? '',
        },
      });
      if (input.status === 'error') {
        await writeNotices(publishErrorNotice({
          userId: userId,
          platformName: NAMES[input.platform] ?? input.platform,
          bookTitle: chapter.project.name,
          chapterTitle: chapter.title,
          error: input.error ?? '',
          deliveryId: row.id,
        }));
      }
      deliveries.push({
        platform: input.platform,
        status: input.status,
        url: input.remoteUrl ?? '',
        error: input.error ?? '',
      });
    };

    if (platforms.includes('site')) {
      await prisma.chapter.update({
        where: { id: chapter.id },
        data: { metadata: toJson(revealMetadata(chapter.metadata)), stage: 'published' },
      });
      await queueAutomaticTimelineAnalysis({ userId, projectId: chapter.projectId, chapterId: chapter.id }, app.log);
      const subs = await prisma.bookSubscription.findMany({
        where: { projectId: chapter.projectId, userId: { not: userId } },
        select: { userId: true },
      });
      if (subs.length > 0) {
        await prisma.readerNotice.createMany({
          data: subs.map((row) => ({
            userId: row.userId,
            projectId: chapter.projectId,
            chapterId: chapter.id,
            bookTitle: chapter.project.name,
            chapterTitle: chapter.title,
            href: chapterPath(chapter.projectId, chapter.id),
          })),
          skipDuplicates: true,
        });
      }
      await writeNotices(chapterNotices({
        actorId: userId,
        subscriberIds: subs.map((row) => row.userId),
        projectId: chapter.projectId,
        chapterId: chapter.id,
        bookTitle: chapter.project.name,
        chapterTitle: chapter.title,
      }));
      await write({ platform: 'site', status: 'ok', remoteUrl: url });
    }

    if (platforms.includes('author_today')) {
      const account = accounts.find((row) => row.platform === 'author_today');
      try {
        if (!account?.secretCipher) throw new Error('Сначала подключите Author.Today');
        const previous = await prisma.publishDelivery.findFirst({
          where: { userId: userId, chapterId: chapter.id, platform: 'author_today', status: 'ok' },
          orderBy: { createdAt: 'desc' },
          select: { remoteId: true },
        });
        const remoteChapterId = Number(previous?.remoteId);
        const chapterOnly = Number.isInteger(remoteChapterId) && remoteChapterId > 0 ? remoteChapterId : undefined;
        const secret = openSecret(account.secretCipher);
        const sent = await publishAuthorTodayChapter(userId, secret, chapter.projectId, chapter.title, chapterHtml(chapter.content), chapterOnly);
        await write({ platform: 'author_today', status: 'ok', remoteId: String(sent.id), remoteUrl: sent.url });
      } catch (err) {
        await write({ platform: 'author_today', status: 'error', error: failureText(err) });
      }
    }

    if (platforms.includes('litnet')) {
      const account = accounts.find((row) => row.platform === 'litnet');
      try {
        if (!account?.secretCipher) throw new Error('Сначала подключите Литнет');
        const previous = await prisma.publishDelivery.findFirst({
          where: { userId: userId, chapterId: chapter.id, platform: 'litnet', status: 'ok' },
          orderBy: { createdAt: 'desc' },
          select: { remoteId: true },
        });
        const remoteChapterId = Number(previous?.remoteId);
        const sent = await publishLitnetChapter(
          account.secretCipher,
          chapter.projectId,
          userId,
          chapter.title,
          chapterHtml(chapter.content),
          Number.isInteger(remoteChapterId) && remoteChapterId > 0 ? remoteChapterId : undefined,
        );
        await write({ platform: 'litnet', status: 'ok', remoteId: String(sent.id), remoteUrl: sent.url });
      } catch (err) {
        await write({ platform: 'litnet', status: 'error', error: failureText(err) });
      }
    }

    if (platforms.includes('boosty')) {
      const account = accounts.find((row) => row.platform === 'boosty');
      try {
        if (!account?.secretCipher) throw new Error('Сначала подключите Boosty');
        const opened = await openBoosty(userId);
        const remotePostId = await latestRemoteId(userId, chapter.id, 'boosty');
        const draft = {
          title: (chapter.title.trim() || 'Глава').slice(0, 200),
          paragraphs: blocks.length > 0 ? blocks : [chapter.title],
          links: url.startsWith('https://') ? [{ url, title: 'Читать на сайте' }] : [],
        };
        let sent;
        try {
          sent = remotePostId
            ? await updateBoostyPost(opened.session, opened.blog, remotePostId, draft)
            : await createBoostyPost(opened.session, opened.blog, draft);
        } catch (err) {
          if (!remotePostId || !(err instanceof Error) || err.message !== 'Boosty не нашёл пост') throw err;
          sent = await createBoostyPost(opened.session, opened.blog, draft);
        }
        await keepBoostySession(opened.account.id, opened.session, sent.session);
        await write({ platform: 'boosty', status: 'ok', remoteId: sent.post.id, remoteUrl: sent.post.url });
      } catch (err) {
        await write({ platform: 'boosty', status: 'error', error: failureText(err) });
      }
    }

    for (const platform of ['sponsr', 'vk', 'telegram', 'discord'] as const) {
      if (!platforms.includes(platform)) continue;
      const account = accounts.find((row) => row.platform === platform);
      try {
        if (!account?.secretCipher) throw new Error('Площадка не подключена');
        const secret = openSecret(account.secretCipher);
        if (platform === 'sponsr' && secret.trim().startsWith('{')) {
          const remotePostId = Number(await latestRemoteId(userId, chapter.id, 'sponsr'));
          const sent = await publishSponsrChapter(
            userId,
            secret,
            account.meta,
            chapter.projectId,
            chapter.project.name,
            chapter.title,
            chapterHtml(chapter.content),
            url,
            Number.isInteger(remotePostId) && remotePostId > 0 ? remotePostId : undefined,
          );
          await write({ platform, status: 'ok', remoteId: sent.id, remoteUrl: sent.url });
          continue;
        }
        if (platform === 'discord') {
          const messageId = await latestRemoteId(userId, chapter.id, 'discord');
          const channel = {
            guildId: metaString(account.meta, 'guildId'),
            channelId: metaString(account.meta, 'channelId'),
          };
          let sent;
          if (messageId) {
            try {
              sent = await editDiscordMessage(secret, messageId, text, channel);
            } catch (err) {
              if (!(err instanceof Error) || err.message !== 'Discord не нашёл сообщение') throw err;
              sent = await postDiscord(secret, text, channel);
            }
          } else {
            sent = await postDiscord(secret, text, channel);
          }
          await write({ platform, status: 'ok', remoteId: sent.id, remoteUrl: sent.url });
          continue;
        }
        const sent = await deliver(platform, secret, account.meta, text, blocks, url, chapter.project.name, chapter.title, chapter.content);
        await write({ platform, status: 'ok', remoteId: sent.id, remoteUrl: sent.url });
      } catch (err) {
        await write({ platform, status: 'error', error: failureText(err) });
      }
    }

    return deliveries;
  }

  app.post<{ Params: { chapterId: string } }>('/api/publish/chapters/:chapterId/sync', async (req, reply) => {
    app.requireAuth(req);
    const chapter = await loadOwnChapter(req.params.chapterId, req.user!.id);
    if (!chapter) return reply.status(404).send({ error: 'Глава не найдена' });
    const owner = await prisma.user.findUnique({ where: { id: req.user!.id }, select: { settings: true } });
    if (!autopostEnabled(owner?.settings) || !bookIsPublished(chapter.project.settings) || chapterIsHidden(chapter.metadata)) {
      return { deliveries: [] as Array<{ platform: string; status: 'ok' | 'error'; url: string; error: string }> };
    }
    const rows = await prisma.publishDelivery.findMany({
      where: {
        userId: req.user!.id,
        chapterId: chapter.id,
        status: 'ok',
        platform: { in: ['site', 'sponsr', 'author_today', 'litnet', 'boosty', 'discord'] },
      },
      orderBy: { createdAt: 'desc' },
      select: { platform: true },
    });
    const seen = new Set<string>();
    const platforms: Array<'sponsr' | 'author_today' | 'litnet' | 'boosty' | 'discord'> = [];
    let site = false;
    for (const row of rows) {
      if (seen.has(row.platform)) continue;
      seen.add(row.platform);
      if (row.platform === 'site') site = true;
      else if (
        row.platform === 'sponsr'
        || row.platform === 'author_today'
        || row.platform === 'litnet'
        || row.platform === 'boosty'
        || row.platform === 'discord'
      ) {
        platforms.push(row.platform);
      }
    }
    if (!site && platforms.length === 0) return { deliveries: [] };
    const url = absoluteUrl(env.FRONTEND_URL, chapterPath(chapter.projectId, chapter.id));
    if (platforms.length === 0) {
      return { deliveries: [{ platform: 'site', status: 'ok' as const, url, error: '' }] };
    }
    const sent = await pushPublishedChapter(req.user!.id, chapter, platforms);
    if (site) sent.unshift({ platform: 'site', status: 'ok', url, error: '' });
    return { deliveries: sent };
  });

  app.post('/api/publish/sponsr/level', async (req, reply) => {
    app.requireAuth(req);
    const parsed = z.object({ levelId: z.number().int().positive().nullable() }).safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: 'Укажите уровень Sponsr или доступ для всех' });
    const account = await prisma.publishAccount.findUnique({
      where: { userId_platform: { userId: req.user!.id, platform: 'sponsr' } },
    });
    if (!account?.secretCipher) return reply.status(400).send({ error: 'Сначала подключите Sponsr' });
    const levels = metaLevels(account.meta);
    if (parsed.data.levelId !== null && !levels.some((level) => level.id === parsed.data.levelId)) {
      return reply.status(400).send({ error: 'Такого уровня на Sponsr нет' });
    }
    const previous = account.meta && typeof account.meta === 'object' && !Array.isArray(account.meta)
      ? account.meta as Record<string, unknown>
      : {};
    const row = await prisma.publishAccount.update({
      where: { id: account.id },
      data: { meta: toJson({ ...previous, levelId: parsed.data.levelId }) },
    });
    return { account: await present(row) };
  });

  app.post('/api/publish/sponsr/post', async (req, reply) => {
    app.requireAuth(req);
    const parsed = z.object({
      title: z.string().trim().min(4).max(256),
      text: z.string().max(150_000).default(''),
      links: z.array(z.object({
        url: z.string().trim().max(500),
        title: z.string().trim().max(200).optional(),
      })).max(10).default([]),
      images: z.array(z.object({
        url: z.string().trim().max(500),
        alt: z.string().trim().max(200).optional(),
      })).max(10).default([]),
      notify: z.boolean().default(false),
      remoteId: z.number().int().positive().optional(),
    }).safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: 'Заголовок Sponsr — от 4 до 256 знаков' });
    const html = sponsrDocument({
      body: plainSponsr(parsed.data.text),
      links: parsed.data.links,
      images: parsed.data.images,
    });
    if (!html) return reply.status(400).send({ error: 'Нужен текст, ссылка https или картинка по адресу https' });
    const owner = await prisma.user.findUnique({ where: { id: req.user!.id }, select: { settings: true } });
    if (!autopostEnabled(owner?.settings)) {
      return reply.status(400).send({ error: 'Автопубликация выключена. Включите её на странице «Автопост».' });
    }
    const account = await prisma.publishAccount.findUnique({
      where: { userId_platform: { userId: req.user!.id, platform: 'sponsr' } },
    });
    if (!account?.secretCipher) return reply.status(400).send({ error: 'Сначала подключите Sponsr' });
    const secret = openSecret(account.secretCipher);
    if (secret.trim().startsWith('{')) {
      try {
        return await publishSponsrSession(req.user!.id, account.meta, secret, {
          remoteId: parsed.data.remoteId,
          title: parsed.data.title,
          html,
          notify: parsed.data.notify,
        });
      } catch (err) {
        return reply.status(400).send({ error: err instanceof Error ? err.message : 'Sponsr отклонил пост' });
      }
    }
    try {
      const sent = await postSponsr(secret, sponsrPostBody({
        title: parsed.data.title,
        html,
        date: new Date().toISOString(),
        levelId: metaLevel(account.meta),
        notify: parsed.data.notify,
      }));
      return sent;
    } catch (err) {
      return reply.status(400).send({ error: err instanceof Error ? err.message : 'Sponsr отклонил пост' });
    }
  });

  app.put('/api/publish/sponsr/post/:postId', async (req, reply) => {
    app.requireAuth(req);
    const postId = Number((req.params as { postId?: string }).postId);
    const parsed = z.object({
      title: z.string().trim().min(4).max(256),
      text: z.string().max(150_000).default(''),
      links: z.array(z.object({
        url: z.string().trim().max(500),
        title: z.string().trim().max(200).optional(),
      })).max(10).default([]),
      images: z.array(z.object({
        url: z.string().trim().max(500),
        alt: z.string().trim().max(200).optional(),
      })).max(10).default([]),
      notify: z.boolean().default(false),
      remoteId: z.number().int().positive().optional(),
    }).safeParse(req.body);
    if (!parsed.success || !Number.isInteger(postId) || postId <= 0) {
      return reply.status(400).send({ error: 'Заголовок Sponsr — от 4 до 256 знаков' });
    }
    const html = sponsrDocument({
      body: plainSponsr(parsed.data.text),
      links: parsed.data.links,
      images: parsed.data.images,
    });
    if (!html) return reply.status(400).send({ error: 'Нужен текст, ссылка https или картинка по адресу https' });
    const account = await prisma.publishAccount.findUnique({
      where: { userId_platform: { userId: req.user!.id, platform: 'sponsr' } },
    });
    if (!account?.secretCipher) return reply.status(400).send({ error: 'Сначала подключите Sponsr' });
    const secret = openSecret(account.secretCipher);
    if (!secret.trim().startsWith('{')) return reply.status(400).send({ error: 'Правка поста есть у сессии Sponsr' });
    try {
      return await publishSponsrSession(req.user!.id, account.meta, secret, {
        remoteId: parsed.data.remoteId,
        postId,
        title: parsed.data.title,
        html,
        notify: parsed.data.notify,
      });
    } catch (err) {
      return reply.status(400).send({ error: err instanceof Error ? err.message : 'Sponsr отклонил правку' });
    }
  });

  app.post('/api/publish/author-today/session', async (req, reply) => {
    app.requireAuth(req);
    const parsed = z.object({ paste: z.string().max(20_000) }).safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: 'Вставьте cookie LoginCookie' });
    try {
      const identity = await connectAuthorToday(parsed.data.paste);
      const row = await storeAuthorToday(req.user!.id, identity);
      return { account: await present(row) };
    } catch (err) {
      return reply.status(400).send({ error: err instanceof Error ? err.message : 'Author.Today не принял сессию' });
    }
  });

  app.post('/api/publish/author-today/password', async (req, reply) => acceptPassword(req, reply, 'author_today'));

  app.post('/api/publish/litnet/session', async (req, reply) => {
    app.requireAuth(req);
    const parsed = z.object({ paste: z.string().max(20_000) }).safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: 'Вставьте cookie _internal_access_token' });
    try {
      const identity = await connectLitnet(parsed.data.paste);
      const existing = await prisma.publishAccount.findUnique({
        where: { userId_platform: { userId: req.user!.id, platform: 'litnet' } },
        select: { meta: true },
      });
      const previous = existing?.meta && typeof existing.meta === 'object' && !Array.isArray(existing.meta)
        ? existing.meta as Record<string, unknown>
        : {};
      const row = await prisma.publishAccount.upsert({
        where: { userId_platform: { userId: req.user!.id, platform: 'litnet' } },
        create: {
          userId: req.user!.id,
          platform: 'litnet',
          label: identity.user.name,
          secretCipher: sealSecret(litnetSessionJson(identity.token)),
          secretHint: secretHint(identity.token),
          meta: toJson({ ...previous, projects: identity.books }),
        },
        update: {
          label: identity.user.name,
          secretCipher: sealSecret(litnetSessionJson(identity.token)),
          secretHint: secretHint(identity.token),
          meta: toJson({ ...previous, projects: identity.books }),
        },
      });
      return { account: await present(row) };
    } catch (err) {
      return reply.status(400).send({ error: err instanceof Error ? err.message : 'Литнет не принял сессию' });
    }
  });

  async function acceptPassword(req: Parameters<typeof app.requireAuth>[0], reply: { status: (code: number) => { send: (body: unknown) => unknown } }, forced?: 'author_today') {
    app.requireAuth(req);
    const parsed = z.object({
      platform: z.enum(['author_today', 'wattpad', 'boosty']).optional(),
      login: z.string().trim().min(1).max(200),
      password: z.string().min(1).max(500),
      code: z.string().trim().max(20).optional(),
    }).safeParse(req.body);
    const platform = forced ?? parsed.data?.platform;
    if (!parsed.success || !platform) return reply.status(400).send({ error: 'Введите логин и пароль' });
    const { login, password, code } = parsed.data;
    try {
      const account = platform === 'author_today'
        ? await present(await storeAuthorToday(req.user!.id, await loginAuthorToday({ login, password, code })))
        : platform === 'wattpad'
          ? await present(await storeWattpad(req.user!.id, await loginWattpad({ login, password })))
          : (await storeBoostySession(req.user!.id, (await loginBoosty({ login, password })).session)).account;
      await prisma.publishVault.upsert({
        where: { userId_platform: { userId: req.user!.id, platform } },
        create: {
          userId: req.user!.id,
          platform,
          loginSeal: sealSecret(login),
          passwordSeal: sealSecret(password),
        },
        update: {
          loginSeal: sealSecret(login),
          passwordSeal: sealSecret(password),
        },
      });
      return { account };
    } catch (err) {
      if (err instanceof AuthorTodayChallenge) return { need: err.need };
      const message = err instanceof Error ? err.message : 'Площадка не пустила';
      const hidden = password ? message.split(password).join('') : message;
      return reply.status(400).send({ error: hidden.replace(/\s+/g, ' ').trim().slice(0, 180) || 'Площадка не пустила' });
    }
  }

  app.post('/api/publish/password', async (req, reply) => acceptPassword(req, reply));

  app.post('/api/publish/wattpad/session', async (req, reply) => {
    app.requireAuth(req);
    const parsed = z.object({ paste: z.string().max(20_000) }).safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: 'Вставьте cookie token' });
    try {
      const identity = await connectWattpad(parsed.data.paste);
      const existing = await prisma.publishAccount.findUnique({
        where: { userId_platform: { userId: req.user!.id, platform: 'wattpad' } },
        select: { meta: true },
      });
      const previous = existing?.meta && typeof existing.meta === 'object' && !Array.isArray(existing.meta)
        ? existing.meta as Record<string, unknown>
        : {};
      const row = await prisma.publishAccount.upsert({
        where: { userId_platform: { userId: req.user!.id, platform: 'wattpad' } },
        create: {
          userId: req.user!.id,
          platform: 'wattpad',
          label: identity.user.name,
          secretCipher: sealSecret(wattpadSessionJson(identity.token)),
          secretHint: secretHint(identity.token),
          meta: toJson({ ...previous, projects: identity.stories }),
        },
        update: {
          label: identity.user.name,
          secretCipher: sealSecret(wattpadSessionJson(identity.token)),
          secretHint: secretHint(identity.token),
          meta: toJson({ ...previous, projects: identity.stories }),
        },
      });
      return { account: await present(row) };
    } catch (err) {
      return reply.status(400).send({ error: err instanceof Error ? err.message : 'Wattpad не принял сессию' });
    }
  });

  app.get('/api/publish/telegram', async (req) => {
    app.requireAuth(req);
    return telegramStatus(req.user!.id);
  });

  app.post('/api/publish/telegram/invite', async (req, reply) => {
    app.requireAuth(req);
    try {
      return await createTelegramInvite(req.user!.id);
    } catch (err) {
      return reply.status(400).send({ error: err instanceof Error ? err.message : 'Telegram не выдал ссылку' });
    }
  });

  app.post('/api/publish/author-today/chapter', async (req, reply) => {
    app.requireAuth(req);
    const parsed = z.object({
      remoteId: z.number().int().positive(),
      title: z.string().trim().min(1).max(200),
      text: z.string().trim().min(1).max(200_000),
      draft: z.boolean().optional(),
    }).safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: 'Укажите произведение, заголовок и текст главы' });
    const account = await prisma.publishAccount.findUnique({
      where: { userId_platform: { userId: req.user!.id, platform: 'author_today' } },
    });
    if (!account?.secretCipher) return reply.status(400).send({ error: 'Сначала подключите Author.Today' });
    const works = metaProjects(account.meta);
    if (!works.some((work) => work.id === parsed.data.remoteId)) {
      return reply.status(400).send({ error: 'Этого произведения нет в подключённом аккаунте' });
    }
    try {
      const sent = await saveAuthorTodayFromAccount(req.user!.id, openSecret(account.secretCipher), {
        workId: parsed.data.remoteId,
        title: parsed.data.title,
        html: parsed.data.text,
        draft: parsed.data.draft === true,
      });
      return { id: String(sent.id), url: sent.url };
    } catch (err) {
      return reply.status(400).send({ error: err instanceof Error ? err.message : 'Author.Today не принял главу' });
    }
  });

  app.put<{ Params: { chapterId: string } }>('/api/publish/author-today/chapter/:chapterId', async (req, reply) => {
    app.requireAuth(req);
    const chapterId = Number(req.params.chapterId);
    const parsed = z.object({
      remoteId: z.number().int().positive(),
      title: z.string().trim().min(1).max(200),
      text: z.string().trim().min(1).max(200_000),
      draft: z.boolean().optional(),
    }).safeParse(req.body);
    if (!Number.isInteger(chapterId) || chapterId <= 0 || !parsed.success) {
      return reply.status(400).send({ error: 'Укажите главу, произведение и текст' });
    }
    const account = await prisma.publishAccount.findUnique({
      where: { userId_platform: { userId: req.user!.id, platform: 'author_today' } },
    });
    if (!account?.secretCipher) return reply.status(400).send({ error: 'Сначала подключите Author.Today' });
    try {
      const sent = await saveAuthorTodayFromAccount(req.user!.id, openSecret(account.secretCipher), {
        workId: parsed.data.remoteId,
        chapterId,
        title: parsed.data.title,
        html: parsed.data.text,
        draft: parsed.data.draft === true,
      });
      return { id: String(sent.id), url: sent.url };
    } catch (err) {
      return reply.status(400).send({ error: err instanceof Error ? err.message : 'Author.Today не принял правку' });
    }
  });

  app.patch('/api/publish/links', async (req, reply) => {
    app.requireAuth(req);
    const parsed = z.object({
      platform: z.enum(['sponsr', 'author_today', 'litnet', 'wattpad']),
      remoteId: z.string().regex(/^\d+$/),
      projectId: z.string().min(1).nullable(),
    }).safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: 'Выберите книгу' });
    const link = await prisma.publishLink.findUnique({
      where: {
        userId_platform_remoteId: {
          userId: req.user!.id,
          platform: parsed.data.platform,
          remoteId: parsed.data.remoteId,
        },
      },
    });
    if (!link) return reply.status(400).send({ error: 'Произведение на площадке не найдено' });
    if (parsed.data.projectId) {
      const book = await prisma.project.findFirst({
        where: {
          id: parsed.data.projectId,
          OR: [
            { ownerId: req.user!.id },
            { ProjectCollaborator: { some: { userId: req.user!.id, status: 'active' } } },
          ],
        },
        select: { id: true },
      });
      if (!book) return reply.status(400).send({ error: 'Эта книга вам недоступна' });
    }
    await prisma.publishLink.update({
      where: { id: link.id },
      data: { projectId: parsed.data.projectId },
    });
    const account = await prisma.publishAccount.findUnique({
      where: { userId_platform: { userId: req.user!.id, platform: parsed.data.platform } },
    });
    return account ? { account: await present(account) } : { ok: true as const };
  });

  app.get('/api/publish/settings', async (req) => {
    app.requireAuth(req);
    const owner = await prisma.user.findUnique({ where: { id: req.user!.id }, select: { settings: true } });
    return { enabled: autopostEnabled(owner?.settings) };
  });

  app.patch('/api/publish/settings', async (req, reply) => {
    app.requireAuth(req);
    const parsed = z.object({ enabled: z.boolean() }).safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: 'Укажите, включена ли автопубликация' });
    const owner = await prisma.user.findUnique({ where: { id: req.user!.id }, select: { settings: true } });
    const settings = owner?.settings && typeof owner.settings === 'object' && !Array.isArray(owner.settings)
      ? owner.settings as Record<string, unknown>
      : {};
    const previous = settings.autopost && typeof settings.autopost === 'object' && !Array.isArray(settings.autopost)
      ? settings.autopost as Record<string, unknown>
      : {};
    await prisma.user.update({
      where: { id: req.user!.id },
      data: { settings: toJson({ ...settings, autopost: { ...previous, enabled: parsed.data.enabled } }) },
    });
    return { enabled: parsed.data.enabled };
  });

  app.get('/api/reader-notices', async (req) => {
    app.requireAuth(req);
    const geo = await countryBlocks(req);
    const rows = await prisma.readerNotice.findMany({
      where: { userId: req.user!.id },
      orderBy: { createdAt: 'desc' },
      take: 40,
      select: {
        id: true,
        bookTitle: true,
        chapterTitle: true,
        href: true,
        createdAt: true,
        projectId: true,
        chapterId: true,
      },
    });
    return {
      notices: rows
        .filter((row) => row.href.startsWith('/read/') && !chapterBlocked(geo.index, geo.country, row.projectId, row.chapterId))
        .slice(0, 8)
        .map((row) => ({
          id: row.id,
          bookTitle: row.bookTitle,
          chapterTitle: row.chapterTitle,
          href: row.href,
          createdAt: row.createdAt.toISOString(),
        })),
    };
  });
};

async function loadOwnChapter(chapterId: string, userId: string) {
  const chapter = await prisma.chapter.findFirst({
    where: { id: chapterId },
    select: {
      id: true,
      projectId: true,
      title: true,
      content: true,
      metadata: true,
      project: { select: { name: true, ownerId: true, settings: true } },
    },
  });
  if (!chapter || chapter.project.ownerId !== userId) return null;
  return chapter;
}

function draft(chapter: { title: string; content: unknown; project: { name: string } }, url: string): string {
  return announcement({
    book: chapter.project.name,
    chapter: chapter.title,
    text: chapterBlocks(chapter.content).join(' '),
    url,
    limit: 2000,
  });
}

async function deliver(
  platform: 'sponsr' | 'vk' | 'telegram' | 'discord',
  secret: string,
  meta: unknown,
  text: string,
  blocks: string[],
  url: string,
  book: string,
  title: string,
  content: unknown,
): Promise<{ id: string; url: string }> {
  if (platform === 'sponsr') {
    if (secret.trim().startsWith('{')) throw new Error('Сессия Sponsr подключена. Публикация поста из неё будет следующим шагом.');
    const html = sponsrDocument({ body: chapterHtml(content), url }) || sponsrText(blocks, url);
    return postSponsr(secret, sponsrPostBody({
      title: sponsrTitle(title, book),
      html,
      date: new Date().toISOString(),
      levelId: metaLevel(meta),
      notify: true,
    }));
  }
  if (platform === 'vk') {
    const ownerId = metaString(meta, 'ownerId');
    if (!ownerId) throw new Error('В подключении ВК нет id стены');
    return postVk(secret, ownerId, text);
  }
  if (platform === 'telegram') {
    const chatId = metaString(meta, 'chatId');
    if (!chatId) throw new Error('В подключении Telegram нет id чата');
    const token = metaString(meta, 'via') === 'bot' ? env.TELEGRAM_BOT_TOKEN : secret;
    if (!token) throw new Error('Бот Telegram не настроен');
    return postTelegram(token, chatId, text);
  }
  return postDiscord(secret, text, {
    guildId: metaString(meta, 'guildId'),
    channelId: metaString(meta, 'channelId'),
  });
}
