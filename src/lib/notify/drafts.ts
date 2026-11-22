export const NOTICE_KINDS = [
  'chapter',
  'book_comment',
  'comment_reply',
  'blog_post',
  'blog_comment',
  'reader_report',
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
  return {
    chapter: noticeChoice(settings, 'chapter'),
    book_comment: noticeChoice(settings, 'book_comment'),
    comment_reply: noticeChoice(settings, 'comment_reply'),
    blog_post: noticeChoice(settings, 'blog_post'),
    blog_comment: noticeChoice(settings, 'blog_comment'),
    reader_report: noticeChoice(settings, 'reader_report'),
  };
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
