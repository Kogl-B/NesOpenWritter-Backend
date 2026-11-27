export const NOTICE_KINDS = [
  'chapter',
  'book_comment',
  'comment_reply',
  'blog_post',
  'blog_comment',
  'reader_report',
  'publish_error',
  'book_subscription',
  'follow',
  'blog_donation',
  'blog_report',
  'book_status',
  'digest',
  'ai_result',
] as const;

export type NoticeKind = (typeof NOTICE_KINDS)[number];

export type NoticeDraft = {
  userId: string;
  kind: NoticeKind;
  title: string;
  body: string;
  href: string;
  eventKey: string;
};

const TITLE = 180;
const BODY = 160;

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max - 1)}…`;
}

function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function others(ids: string[], actorId: string): string[] {
  return [...new Set(ids.filter((id) => id && id !== actorId))];
}

/** Явный false выключает вид. Пустая настройка значит «присылать». */
export function noticeChoice(settings: unknown, kind: NoticeKind): boolean {
  const notices = record(record(settings)?.notices);
  if (!notices || !(kind in notices)) return true;
  return notices[kind] !== false;
}

export function readerReportsOpen(settings: unknown): boolean {
  const root = record(settings);
  if (!root) return true;
  return root.readerReports !== false;
}

export function noticeAllowed(settings: unknown, kind: NoticeKind): boolean {
  if (!noticeChoice(settings, kind)) return false;
  if (kind === 'reader_report' && !readerReportsOpen(settings)) return false;
  return true;
}

export function noticePrefs(settings: unknown): Record<NoticeKind, boolean> {
  return Object.fromEntries(
    NOTICE_KINDS.map((kind) => [kind, noticeChoice(settings, kind)]),
  ) as Record<NoticeKind, boolean>;
}

export function mergeNoticeSettings(
  settings: unknown,
  patch: Partial<Record<NoticeKind, boolean>>,
): Record<string, unknown> {
  const root = record(settings) ?? {};
  const prev = record(root.notices) ?? {};
  const next: Record<string, boolean> = {};
  for (const kind of NOTICE_KINDS) {
    if (typeof prev[kind] === 'boolean') next[kind] = prev[kind];
    if (typeof patch[kind] === 'boolean') next[kind] = patch[kind];
  }
  return { ...root, notices: next };
}

export function chapterNotices(input: {
  actorId: string;
  subscriberIds: string[];
  projectId: string;
  chapterId: string;
  bookTitle: string;
  chapterTitle: string;
}): NoticeDraft[] {
  const title = clip(input.bookTitle, 120);
  return others(input.subscriberIds, input.actorId).map((userId) => ({
    userId,
    kind: 'chapter',
    title: clip(title ? `Новая глава «${title}»` : 'Новая глава', TITLE),
    body: clip(input.chapterTitle, BODY),
    href: `/read/${input.projectId}?c=${input.chapterId}`,
    eventKey: `chapter:${input.chapterId}`,
  }));
}

export function commentNotices(input: {
  target: 'book' | 'blog';
  actorId: string;
  actorName: string;
  ownerId: string;
  parentUserId: string;
  commentId: string;
  subjectId: string;
  subjectTitle: string;
  body: string;
}): NoticeDraft[] {
  const name = clip(input.actorName || 'Читатель', 80);
  const text = clip(input.body, BODY);
  const subject = clip(input.subjectTitle, 120);
  const href = input.target === 'book'
    ? `/books/${input.subjectId}#comment-${input.commentId}`
    : `/blog/${input.subjectId}#comment-${input.commentId}`;
  const drafts: NoticeDraft[] = [];
  if (input.parentUserId && input.parentUserId !== input.actorId) {
    drafts.push({
      userId: input.parentUserId,
      kind: 'comment_reply',
      title: 'Ответ на ваш комментарий',
      body: clip(`${name}: ${text}`, BODY),
      href,
      eventKey: `reply:${input.commentId}`,
    });
  }
  if (input.ownerId && input.ownerId !== input.actorId && input.ownerId !== input.parentUserId) {
    const title = input.target === 'book'
      ? (subject ? `Комментарий к «${subject}»` : 'Комментарий к книге')
      : (subject ? `Комментарий к записи «${subject}»` : 'Комментарий к записи');
    drafts.push({
      userId: input.ownerId,
      kind: input.target === 'book' ? 'book_comment' : 'blog_comment',
      title: clip(title, TITLE),
      body: clip(`${name}: ${text}`, BODY),
      href,
      eventKey: `${input.target}-comment:${input.commentId}`,
    });
  }
  return drafts;
}

export function blogPostNotices(input: {
  authorId: string;
  authorName: string;
  postId: string;
  title: string;
  audienceIds: string[];
}): NoticeDraft[] {
  const title = clip(input.title, 120);
  const author = clip(input.authorName || 'Автор', 80);
  return others(input.audienceIds, input.authorId).map((userId) => ({
    userId,
    kind: 'blog_post',
    title: clip(title ? `Новая запись «${title}»` : 'Новая запись в блоге', TITLE),
    body: author,
    href: `/blog/${input.postId}`,
    eventKey: `blog:${input.postId}`,
  }));
}

export function readerReportNotice(input: {
  authorId: string;
  reportId: string;
  bookTitle: string;
  quote: string;
}): NoticeDraft[] {
  if (!input.authorId) return [];
  const book = clip(input.bookTitle, 120);
  return [{
    userId: input.authorId,
    kind: 'reader_report',
    title: clip(book ? `Замечание к «${book}»` : 'Замечание к тексту', TITLE),
    body: clip(input.quote, BODY),
    href: '/account#reader-reports',
    eventKey: `report:${input.reportId}`,
  }];
}

export function publishErrorNotice(input: {
  userId: string;
  platformName: string;
  bookTitle: string;
  chapterTitle: string;
  error: string;
  deliveryId: string;
}): NoticeDraft[] {
  if (!input.userId || !input.deliveryId) return [];
  const platform = clip(input.platformName || 'Площадка', 40);
  const book = clip(input.bookTitle, 80);
  const chapter = clip(input.chapterTitle, 80);
  const place = book && chapter ? `«${book}»: ${chapter}` : book ? `«${book}»` : chapter;
  const error = clip(input.error, 120);
  return [{
    userId: input.userId,
    kind: 'publish_error',
    title: 'Площадка не приняла главу',
    body: clip([platform, place, error].filter(Boolean).join('. '), BODY),
    href: '/account/autopost',
    eventKey: `publish-fail:${input.deliveryId}`,
  }];
}

export function followNotice(input: {
  authorId: string;
  actorId: string;
  actorName: string;
}): NoticeDraft[] {
  if (!input.authorId || !input.actorId || input.authorId === input.actorId) return [];
  return [{
    userId: input.authorId,
    kind: 'follow',
    title: 'Блог начали отслеживать',
    body: clip(input.actorName || 'Читатель', 80),
    href: `/authors/${input.authorId}`,
    eventKey: `follow:${input.actorId}`,
  }];
}

export function bookSubscriptionNotice(input: {
  ownerId: string;
  actorId: string;
  actorName: string;
  projectId: string;
  bookTitle: string;
}): NoticeDraft[] {
  if (!input.ownerId || !input.actorId || input.ownerId === input.actorId || !input.projectId) return [];
  const book = clip(input.bookTitle, 120);
  return [{
    userId: input.ownerId,
    kind: 'book_subscription',
    title: clip(book ? `Подписка на «${book}»` : 'Подписка на книгу', TITLE),
    body: clip(input.actorName || 'Читатель', 80),
    href: `/books/${input.projectId}`,
    eventKey: `book-sub:${input.actorId}:${input.projectId}`,
  }];
}

export function donationNotice(input: {
  authorId: string;
  actorId: string;
  actorName: string;
  amountCents: number;
  postId: string;
  postTitle: string;
  donationId: string;
  note?: string;
}): NoticeDraft[] {
  if (!input.authorId || !input.actorId || input.authorId === input.actorId || !input.donationId) return [];
  const title = clip(input.postTitle, 100);
  const name = clip(input.actorName || 'Читатель', 80);
  const note = clip(input.note ?? '', 80);
  const money = `${(input.amountCents / 100).toLocaleString('ru-RU')} BYN`;
  return [{
    userId: input.authorId,
    kind: 'blog_donation',
    title: clip(title ? `Донат к «${title}»` : 'Донат к записи', TITLE),
    body: clip(note ? `${name}, ${money}. ${note}` : `${name}, ${money}`, BODY),
    href: `/blog/${input.postId}`,
    eventKey: `donation:${input.donationId}`,
  }];
}

export function blogReportNotice(input: {
  authorId: string;
  actorId: string;
  postId: string;
  postTitle: string;
  reportId: string;
  note: string;
}): NoticeDraft[] {
  if (!input.authorId || input.authorId === input.actorId || !input.reportId) return [];
  const title = clip(input.postTitle, 100);
  return [{
    userId: input.authorId,
    kind: 'blog_report',
    title: clip(title ? `Жалоба на «${title}»` : 'Жалоба на запись', TITLE),
    body: clip(input.note, BODY),
    href: `/blog/${input.postId}`,
    eventKey: `blog-report:${input.reportId}`,
  }];
}

export function bookStatusNotices(input: {
  actorId: string;
  subscriberIds: string[];
  projectId: string;
  bookTitle: string;
  status: 'complete' | 'frozen';
  at?: number;
}): NoticeDraft[] {
  if (!input.projectId) return [];
  const book = clip(input.bookTitle, 120);
  const done = input.status === 'complete';
  const title = done
    ? (book ? `«${book}» завершена` : 'Книга завершена')
    : (book ? `«${book}» заморожена` : 'Книга заморожена');
  const stamp = input.at ?? Date.now();
  return others(input.subscriberIds, input.actorId).map((userId) => ({
    userId,
    kind: 'book_status',
    title: clip(title, TITLE),
    body: done ? 'Теперь книга завершена' : 'Теперь книга заморожена',
    href: `/books/${input.projectId}`,
    eventKey: `book-status:${input.projectId}:${input.status}:${stamp}`,
  }));
}

const DIGEST_SPLIT = '\n\u001e';

export type DigestBucket = 'likes' | 'reading' | 'reactions';

export type DigestState = Record<DigestBucket, string[]>;

export function digestDay(date: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Moscow',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

export function bookDigestKey(projectId: string, day: string): string {
  return `day:${day}:book:${projectId}`;
}

export function blogDigestKey(postId: string, day: string): string {
  return `day:${day}:blog:${postId}`;
}

function plural(n: number, one: string, few: string, many: string): string {
  const n10 = n % 10;
  const n100 = n % 100;
  const word = n10 === 1 && n100 !== 11 ? one : n10 >= 2 && n10 <= 4 && (n100 < 12 || n100 > 14) ? few : many;
  return `${n} ${word}`;
}

function readingLine(n: number): string {
  const n10 = n % 10;
  const n100 = n % 100;
  if (n10 === 1 && n100 !== 11) return `${n} человек читает`;
  if (n10 >= 2 && n10 <= 4 && (n100 < 12 || n100 > 14)) return `${n} человека читают`;
  return `${n} человек читают`;
}

function digestIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((id): id is string => typeof id === 'string' && id.length > 0 && id.length <= 64))].sort();
}

export function readDigest(body: string): DigestState {
  const raw = body.split(DIGEST_SPLIT)[1] ?? '';
  if (!raw) return { likes: [], reading: [], reactions: [] };
  try {
    const parsed = JSON.parse(raw) as Partial<DigestState>;
    return {
      likes: digestIds(parsed.likes),
      reading: digestIds(parsed.reading),
      reactions: digestIds(parsed.reactions),
    };
  } catch {
    return { likes: [], reading: [], reactions: [] };
  }
}

export function digestText(state: DigestState): string {
  const parts: string[] = [];
  if (state.likes.length > 0) parts.push(plural(state.likes.length, 'лайк', 'лайка', 'лайков'));
  if (state.reading.length > 0) parts.push(readingLine(state.reading.length));
  if (state.reactions.length > 0) parts.push(plural(state.reactions.length, 'реакция', 'реакции', 'реакций'));
  return parts.join(' · ');
}

export function digestHeading(subject: string): string {
  const title = clip(subject, 100);
  return clip(title ? `Отметки «${title}»` : 'Отметки за день', TITLE);
}

export function publicNoticeBody(body: string): string {
  return (body.split(DIGEST_SPLIT)[0] ?? '').trim();
}

function packDigest(state: DigestState): string {
  return `${digestText(state)}${DIGEST_SPLIT}${JSON.stringify(state)}`;
}

/** null — сводку за этот день нужно убрать: отметок не осталось. */
export function applyDigest(body: string, bucket: DigestBucket, actorId: string, on: boolean): string | null {
  if (!actorId) return null;
  const state = readDigest(body);
  const previous = state[bucket];
  const set = new Set(previous);
  if (on) set.add(actorId);
  else set.delete(actorId);
  const next = [...set].sort();
  const unchanged = next.length === previous.length && next.every((id, index) => id === previous[index]);
  if (unchanged) {
    const total = state.likes.length + state.reading.length + state.reactions.length;
    return total === 0 ? null : body;
  }
  state[bucket] = next;
  if (state.likes.length + state.reading.length + state.reactions.length === 0) return null;
  return packDigest(state);
}
