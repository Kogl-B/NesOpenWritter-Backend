import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  blogPostNotices,
  chapterNotices,
  commentNotices,
  mergeNoticeSettings,
  noticeAllowed,
  noticePrefs,
  readerReportNotice,
} from './drafts.js';

describe('черновики уведомлений', () => {
  it('главу получает каждый подписчик, кроме автора, и только один раз', () => {
    const rows = chapterNotices({
      actorId: 'author',
      subscriberIds: ['author', 'a', 'a', 'b', ''],
      projectId: 'book',
      chapterId: 'ch',
      bookTitle: 'Север',
      chapterTitle: 'Глава 2',
    });
    assert.deepEqual(rows.map((row) => row.userId), ['a', 'b']);
    assert.equal(rows[0]?.kind, 'chapter');
    assert.equal(rows[0]?.href, '/read/book?c=ch');
    assert.equal(rows[0]?.eventKey, 'chapter:ch');
    assert.equal(rows[0]?.title, 'Новая глава «Север»');
    assert.equal(rows[0]?.body, 'Глава 2');
  });

  it('свой комментарий к своей книге никого не зовёт', () => {
    assert.deepEqual(commentNotices({
      target: 'book',
      actorId: 'author',
      actorName: 'Анна',
      ownerId: 'author',
      parentUserId: '',
      commentId: 'c1',
      subjectId: 'book',
      subjectTitle: 'Север',
      body: 'сама себе',
    }), []);
  });

  it('комментарий к чужой книге уходит владельцу', () => {
    const [row] = commentNotices({
      target: 'book',
      actorId: 'reader',
      actorName: 'Илья',
      ownerId: 'author',
      parentUserId: '',
      commentId: 'c1',
      subjectId: 'book',
      subjectTitle: 'Север',
      body: 'сильная сцена',
    });
    assert.equal(row?.userId, 'author');
    assert.equal(row?.kind, 'book_comment');
    assert.equal(row?.href, '/books/book#comment-c1');
    assert.equal(row?.body, 'Илья: сильная сцена');
  });

  it('ответ идёт автору комментария и владельцу, если это разные люди', () => {
    const rows = commentNotices({
      target: 'blog',
      actorId: 'reader',
      actorName: 'Илья',
      ownerId: 'author',
      parentUserId: 'other',
      commentId: 'c2',
      subjectId: 'post',
      subjectTitle: 'Черновик',
      body: 'согласен',
    });
    assert.deepEqual(rows.map((row) => [row.userId, row.kind]), [
      ['other', 'comment_reply'],
      ['author', 'blog_comment'],
    ]);
    assert.equal(rows[0]?.href, '/blog/post#comment-c2');
    assert.equal(rows[0]?.eventKey, 'reply:c2');
  });

  it('ответ владельцу не дублируется комментарием к книге', () => {
    const rows = commentNotices({
      target: 'book',
      actorId: 'reader',
      actorName: 'Илья',
      ownerId: 'author',
      parentUserId: 'author',
      commentId: 'c3',
      subjectId: 'book',
      subjectTitle: 'Север',
      body: 'уточнение',
    });
    assert.deepEqual(rows.map((row) => row.kind), ['comment_reply']);
    assert.equal(rows[0]?.userId, 'author');
  });

  it('запись блога видят следящие и подписчики, автор — нет', () => {
    const rows = blogPostNotices({
      authorId: 'author',
      authorName: 'Анна',
      postId: 'post',
      title: 'Новости',
      audienceIds: ['author', 'fan', 'fan', 'paid'],
    });
    assert.deepEqual(rows.map((row) => row.userId), ['fan', 'paid']);
    assert.equal(rows[0]?.kind, 'blog_post');
    assert.equal(rows[0]?.eventKey, 'blog:post');
    assert.equal(rows[0]?.href, '/blog/post');
  });

  it('замечание читателя ведёт в профиль и режется по длине', () => {
    const [row] = readerReportNotice({
      authorId: 'author',
      reportId: 'r1',
      bookTitle: 'Север',
      quote: 'а'.repeat(200),
    });
    assert.equal(row?.kind, 'reader_report');
    assert.equal(row?.href, '/account#reader-reports');
    assert.equal(row?.eventKey, 'report:r1');
    assert.equal(row?.body.length, 160);
    assert.equal(readerReportNotice({ authorId: '', reportId: 'r', bookTitle: '', quote: 'x' }).length, 0);
  });

  it('выключенный вид и закрытые замечания не проходят', () => {
    const muted = { notices: { chapter: false, book_comment: true } };
    assert.equal(noticeAllowed(muted, 'chapter'), false);
    assert.equal(noticeAllowed(muted, 'blog_post'), true);
    assert.equal(noticeAllowed({ readerReports: false, notices: { reader_report: true } }, 'reader_report'), false);
    assert.equal(noticeAllowed({}, 'reader_report'), true);
    assert.equal(noticePrefs(muted).chapter, false);
    assert.equal(noticePrefs(muted).blog_comment, true);
  });

  it('сохранение вида не стирает остальные настройки', () => {
    const next = mergeNoticeSettings({ author: true, notices: { chapter: false } }, { blog_post: false });
    assert.equal(next.author, true);
    assert.deepEqual(next.notices, { chapter: false, blog_post: false });
  });
});
