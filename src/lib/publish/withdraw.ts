import { openSecret, sealSecret, secretHint } from '../ai/secret.js';
import { prisma } from '../prisma.js';
import {
  authorTodaySessionFromJson,
  authorTodaySessionJson,
  readAuthorTodayChapter,
  saveAuthorTodayChapter,
  type AuthorTodaySession,
} from './authorTodayClient.js';
import { deleteBoostyPost } from './boostyClient.js';
import { boostyBlogSlug } from './boostyPost.js';
import { sessionFromJson, sessionJson, type BoostySession } from './boostySession.js';
import { chapterHtml } from './kit.js';
import { litnetSessionFromJson, readLitnetChapter, saveLitnetChapter } from './litnetClient.js';
import { sponsrDocument, type SponsrProject } from './sponsrClient.js';
import { saveSponsrManagePost } from './sponsrManage.js';
import { sponsrSessionFromJson, sponsrSessionJson } from './sponsrSession.js';
import { deleteDiscordMessage } from './send.js';
import { sponsrTitle } from './text.js';

const REMOTES = ['author_today', 'litnet', 'boosty', 'sponsr', 'discord'] as const;

function metaString(meta: unknown, key: string): string {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return '';
  const value = (meta as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : '';
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
    projects.push({ id: row.id, title: row.title, url: row.url });
  }
  return projects;
}

function sponsrProjectFor(projects: SponsrProject[], remoteUrl: string): SponsrProject | null {
  const hit = projects.find((project) => {
    try {
      const slug = new URL(project.url).pathname.split('/').filter(Boolean)[0] ?? '';
      return slug.length > 0 && remoteUrl.includes(`/${slug}/`);
    } catch {
      return false;
    }
  });
  if (hit) return hit;
  return projects.length === 1 ? projects[0] ?? null : null;
}

async function keepAuthorToday(userId: string, previous: AuthorTodaySession, next: AuthorTodaySession) {
  if (next.token === previous.token && next.loginCookie === previous.loginCookie) return;
  await prisma.publishAccount.update({
    where: { userId_platform: { userId, platform: 'author_today' } },
    data: {
      secretCipher: sealSecret(authorTodaySessionJson(next)),
      secretHint: secretHint(next.token),
    },
  });
}

async function keepBoosty(accountId: string, before: BoostySession, after: BoostySession) {
  if (sessionJson(before) === sessionJson(after)) return;
  await prisma.publishAccount.update({
    where: { id: accountId },
    data: {
      secretCipher: sealSecret(sessionJson(after)),
      secretHint: secretHint(after.accessToken),
    },
  });
}

/** Снимает уже отправленную главу с площадок. Сайт скрывается отдельно. */
export async function withdrawChapterRemotes(userId: string, chapter: {
  id: string;
  title: string;
  content: unknown;
  book: string;
}): Promise<void> {
  const rows = await prisma.publishDelivery.findMany({
    where: { userId, chapterId: chapter.id, status: 'ok', platform: { in: [...REMOTES] } },
    orderBy: { createdAt: 'desc' },
    select: { platform: true, remoteId: true, remoteUrl: true },
  });
  const seen = new Set<string>();
  const jobs: Array<Promise<void>> = [];
  for (const row of rows) {
    if (!row.remoteId || seen.has(row.platform)) continue;
    seen.add(row.platform);
    jobs.push(withdrawOne(userId, chapter, row).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : 'площадка не ответила';
      console.error(`withdraw ${row.platform}: ${message}`);
    }));
  }
  await Promise.all(jobs);
}

async function withdrawOne(userId: string, chapter: {
  title: string;
  content: unknown;
  book: string;
}, row: { platform: string; remoteId: string; remoteUrl: string }): Promise<void> {
  const account = await prisma.publishAccount.findUnique({
    where: { userId_platform: { userId, platform: row.platform } },
  });
  if (!account?.secretCipher) return;
  const secret = openSecret(account.secretCipher);
  const title = chapter.title.trim() || 'Глава';
  const html = chapterHtml(chapter.content);
  if (row.platform === 'author_today') {
    const chapterId = Number(row.remoteId);
    if (!Number.isInteger(chapterId) || chapterId <= 0) return;
    const session = authorTodaySessionFromJson(secret);
    const found = await readAuthorTodayChapter(session, chapterId);
    await keepAuthorToday(userId, session, found.session);
    if (!found.chapter) return;
    const sent = await saveAuthorTodayChapter(found.session, {
      workId: found.chapter.workId,
      chapterId,
      title,
      html,
      draft: true,
    });
    await keepAuthorToday(userId, found.session, sent.session);
    return;
  }
  if (row.platform === 'litnet') {
    const chapterId = Number(row.remoteId);
    if (!Number.isInteger(chapterId) || chapterId <= 0) return;
    const token = litnetSessionFromJson(secret);
    const found = await readLitnetChapter(token, chapterId);
    if (!found) return;
    await saveLitnetChapter(token, {
      bookId: found.bookId,
      chapterId,
      title,
      html,
      draft: true,
    });
    return;
  }
  if (row.platform === 'boosty') {
    const session = sessionFromJson(secret);
    const blog = boostyBlogSlug(metaString(account.meta, 'bookUrl'));
    const sent = await deleteBoostyPost(session, blog, row.remoteId);
    await keepBoosty(account.id, session, sent.session);
    return;
  }
  if (row.platform === 'sponsr') {
    const postId = Number(row.remoteId);
    if (!Number.isInteger(postId) || postId <= 0) return;
    const session = sponsrSessionFromJson(secret);
    const project = sponsrProjectFor(metaProjects(account.meta), row.remoteUrl);
    if (!project) return;
    const sent = await saveSponsrManagePost(session, {
      project,
      postId,
      title: sponsrTitle(title, chapter.book),
      html: sponsrDocument({ body: html, url: '' }) || html,
      notify: false,
      status: 'draft',
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
    return;
  }
  if (row.platform === 'discord') await deleteDiscordMessage(secret, row.remoteId);
}
