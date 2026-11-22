import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import { toJson } from '../lib/access.js';
import { env } from '../lib/env.js';
import { prisma } from '../lib/prisma.js';
import { openSecret, sealSecret, secretHint } from '../lib/ai/secret.js';
import { postDiscord, postSponsr, postTelegram, postVk } from '../lib/publish/send.js';
import { absoluteUrl, announcement, chapterBlocks, chapterPath, sponsrText, sponsrTitle } from '../lib/publish/text.js';
import { bookIsPublished, chapterIsHidden, revealMetadata } from '../lib/publish/visibility.js';
import { chapterBlocked } from '../lib/geo/policy.js';
import { countryBlocks } from '../lib/geo/request.js';
import { createBoostyPost, identifyBoosty, updateBoostyPost, uploadBoostyImage } from '../lib/publish/boostyClient.js';
import { loginBoostyInteractive } from '../lib/publish/boostyLogin.js';
import { boostyBlogSlug } from '../lib/publish/boostyPost.js';
import { parseBoostySession, sessionFromJson, sessionJson, type BoostySession } from '../lib/publish/boostySession.js';
import { assertKitUrl, chapterHtml, isKitPlatform, kitPackage } from '../lib/publish/kit.js';
import { plainSponsr, sponsrDocument, sponsrPostBody, type SponsrLevel, type SponsrProject } from '../lib/publish/sponsrClient.js';
import { identifySponsr } from '../lib/publish/sponsrAuth.js';
import { saveSponsrManagePost } from '../lib/publish/sponsrManage.js';
import { parseSponsrSess, sponsrSessionFromJson, sponsrSessionJson } from '../lib/publish/sponsrSession.js';
import { chapterNotices } from '../lib/notify/drafts.js';
import { writeNotices } from '../lib/notify/deliver.js';

const externalSchema = z.enum(['sponsr', 'vk', 'telegram', 'discord']);
const publishSchema = z.object({
  platforms: z.array(z.enum(['site', 'sponsr', 'vk', 'telegram', 'discord'])).min(1).max(5),
});

const NAMES: Record<string, string> = {
  site: 'Сайт',
  sponsr: 'Sponsr',
  vk: 'ВКонтакте',
  telegram: 'Telegram',
  discord: 'Discord',
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
    bookUrl: metaString(row.meta, 'bookUrl'),
    expiresAt: row.platform === 'sponsr' ? metaString(row.meta, 'expiresAt') : '',
    levelId: row.platform === 'sponsr' ? metaLevel(row.meta) : null,
    levels: row.platform === 'sponsr' ? metaLevels(row.meta) : [],
    projects: row.platform === 'sponsr' ? metaProjects(row.meta) : [],
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function syncSponsrLinks(userId: string, projects: SponsrProject[]) {
  for (const project of projects) {
    await prisma.publishLink.upsert({
      where: { userId_platform_remoteId: { userId, platform: 'sponsr', remoteId: String(project.id) } },
      create: {
        userId,
        platform: 'sponsr',
        remoteId: String(project.id),
        remoteTitle: project.title,
        remoteUrl: project.url,
      },
      update: { remoteTitle: project.title, remoteUrl: project.url },
    });
  }
  const links = await prisma.publishLink.findMany({
    where: { userId, platform: 'sponsr' },
    select: { remoteId: true, projectId: true },
  });
  return new Map(links.map((link) => [link.remoteId, link.projectId]));
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
  if (row.platform !== 'sponsr') return card;
  const links = await syncSponsrLinks(row.userId, card.projects);
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
    if (row.url !== '' && !row.url.startsWith('https://sponsr.ru/')) continue;
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
}) {
  const secret = input.secret.trim();
  if (secret.length < 8 || secret.length > 500 || /\s/.test(secret)) {
    throw bad('Ключ площадки выглядит неверно');
  }
  const label = (input.label ?? '').trim().slice(0, 80) || NAMES[input.platform] || input.platform;
  if (input.platform === 'discord' && !/^https:\/\/(discord|discordapp)\.com\/api\/webhooks\/\d+\/[\w-]+$/.test(secret)) {
    throw bad('Нужна ссылка входящего webhook Discord');
  }
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
    return { accounts: await Promise.all(rows.map((row) => present(row))) };
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
    const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
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

    const url = absoluteUrl(env.FRONTEND_URL, chapterPath(chapter.projectId, chapter.id));
    const blocks = chapterBlocks(chapter.content);
    const text = draft(chapter, url);
    const deliveries: Array<{ platform: string; status: 'ok' | 'error'; url: string; error: string }> = [];

    const write = async (input: { platform: string; status: 'ok' | 'error'; remoteId?: string; remoteUrl?: string; error?: string }) => {
      await prisma.publishDelivery.create({
        data: {
          userId: req.user!.id,
          chapterId: chapter.id,
          projectId: chapter.projectId,
          platform: input.platform,
          status: input.status,
          remoteId: input.remoteId ?? '',
          remoteUrl: input.remoteUrl ?? '',
          error: input.error ?? '',
        },
      });
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
        data: { metadata: toJson(revealMetadata(chapter.metadata)) },
      });
      const subs = await prisma.bookSubscription.findMany({
        where: { projectId: chapter.projectId, userId: { not: req.user!.id } },
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
        actorId: req.user!.id,
        subscriberIds: subs.map((row) => row.userId),
        projectId: chapter.projectId,
        chapterId: chapter.id,
        bookTitle: chapter.project.name,
        chapterTitle: chapter.title,
      }));
      await write({ platform: 'site', status: 'ok', remoteUrl: url });
    }

    for (const platform of ['sponsr', 'vk', 'telegram', 'discord'] as const) {
      if (!platforms.includes(platform)) continue;
      const account = accounts.find((row) => row.platform === platform);
      try {
        if (!account) throw new Error('Площадка не подключена');
        const secret = openSecret(account.secretCipher);
        const sent = await deliver(platform, secret, account.meta, text, blocks, url, chapter.project.name, chapter.title, chapter.content);
        await write({ platform, status: 'ok', remoteId: sent.id, remoteUrl: sent.url });
      } catch (err) {
        await write({ platform, status: 'error', error: failureText(err) });
      }
    }

    return { deliveries };
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

  app.patch('/api/publish/links', async (req, reply) => {
    app.requireAuth(req);
    const parsed = z.object({
      platform: z.literal('sponsr'),
      remoteId: z.string().regex(/^\d+$/),
      projectId: z.string().min(1).nullable(),
    }).safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: 'Выберите книгу для проекта Sponsr' });
    const link = await prisma.publishLink.findUnique({
      where: {
        userId_platform_remoteId: {
          userId: req.user!.id,
          platform: parsed.data.platform,
          remoteId: parsed.data.remoteId,
        },
      },
    });
    if (!link) return reply.status(400).send({ error: 'Проект Sponsr не найден' });
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
      where: { userId_platform: { userId: req.user!.id, platform: 'sponsr' } },
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
    return postTelegram(secret, chatId, text);
  }
  return postDiscord(secret, text);
}
