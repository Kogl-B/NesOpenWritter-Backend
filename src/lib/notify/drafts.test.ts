import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  applyDigest,
  blogPostNotices,
  blogReportNotice,
  bookStatusNotices,
  bookSubscriptionNotice,
  chapterNotices,
  commentNotices,
  digestDay,
  digestHeading,
  donationNotice,
  followNotice,
  mergeNoticeSettings,
  noticeAllowed,
  noticePrefs,
  publicNoticeBody,
  publishErrorNotice,
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
    assert.equal(noticePrefs({}).digest, true);
    assert.equal(noticePrefs({}).publish_error, true);
  });

  it('сохранение вида не стирает остальные настройки', () => {
    const next = mergeNoticeSettings({ author: true, notices: { chapter: false } }, { blog_post: false });
    assert.equal(next.author, true);
    assert.deepEqual(next.notices, { chapter: false, blog_post: false });
  });

  it('сбой площадки остаётся в ящике и ведёт в автопост', () => {
    const [row] = publishErrorNotice({
      userId: 'author',
      platformName: 'Sponsr',
      bookTitle: 'Север',
      chapterTitle: 'Глава 2',
      error: 'Ключ площадки повреждён',
      deliveryId: 'd1',
    });
    assert.equal(row?.kind, 'publish_error');
    assert.equal(row?.title, 'Площадка не приняла главу');
    assert.equal(row?.href, '/account/autopost');
    assert.equal(row?.eventKey, 'publish-fail:d1');
    assert.match(row?.body ?? '', /Sponsr/);
    assert.equal(publishErrorNotice({
      userId: '', platformName: 'Sponsr', bookTitle: '', chapterTitle: '', error: '', deliveryId: 'd',
    }).length, 0);
  });

  it('отслеживание и подписка на книгу — одно событие на человека, себе не шлём', () => {
    const [follow] = followNotice({ authorId: 'author', actorId: 'fan', actorName: 'Ира' });
    assert.equal(follow?.kind, 'follow');
    assert.equal(follow?.eventKey, 'follow:fan');
    assert.equal(follow?.body, 'Ира');
    assert.equal(followNotice({ authorId: 'author', actorId: 'author', actorName: 'Анна' }).length, 0);

    const [sub] = bookSubscriptionNotice({
      ownerId: 'author',
      actorId: 'fan',
      actorName: 'Ира',
      projectId: 'book',
      bookTitle: 'Север',
    });
    assert.equal(sub?.kind, 'book_subscription');
    assert.equal(sub?.title, 'Подписка на «Север»');
    assert.equal(sub?.eventKey, 'book-sub:fan:book');
    assert.equal(sub?.href, '/books/book');
    assert.equal(bookSubscriptionNotice({
      ownerId: 'author', actorId: 'author', actorName: 'Анна', projectId: 'book', bookTitle: 'Север',
    }).length, 0);
  });

  it('донат и жалоба идут автору записи, но не самому себе', () => {
    const [donation] = donationNotice({
      authorId: 'author',
      actorId: 'fan',
      actorName: 'Ира',
      amountCents: 10000,
      postId: 'post',
      postTitle: 'Новости',
      donationId: 'pay',
      note: 'Спасибо',
    });
    assert.equal(donation?.kind, 'blog_donation');
    assert.equal(donation?.title, 'Донат к «Новости»');
    assert.equal(donation?.eventKey, 'donation:pay');
    assert.match(donation?.body ?? '', /100 BYN/);
    assert.equal(donationNotice({
      authorId: 'author', actorId: 'author', actorName: 'Анна', amountCents: 1000, postId: 'post', postTitle: '', donationId: 'pay',
    }).length, 0);

    const [report] = blogReportNotice({
      authorId: 'author',
      actorId: 'fan',
      postId: 'post',
      postTitle: 'Новости',
      reportId: 'r1',
      note: 'Оскорбление',
    });
    assert.equal(report?.kind, 'blog_report');
    assert.equal(report?.eventKey, 'blog-report:r1');
    assert.equal(report?.href, '/blog/post');
    assert.equal(blogReportNotice({
      authorId: 'author', actorId: 'author', postId: 'post', postTitle: '', reportId: 'r', note: 'x',
    }).length, 0);
  });

  it('завершение и заморозка доходят подписчикам, повторный статус можно прислать снова', () => {
    const rows = bookStatusNotices({
      actorId: 'author',
      subscriberIds: ['author', 'fan', 'fan'],
      projectId: 'book',
      bookTitle: 'Север',
      status: 'complete',
      at: 10,
    });
    assert.deepEqual(rows.map((row) => row.userId), ['fan']);
    assert.equal(rows[0]?.title, '«Север» завершена');
    assert.equal(rows[0]?.eventKey, 'book-status:book:complete:10');
    const frozen = bookStatusNotices({
      actorId: 'author',
      subscriberIds: ['fan'],
      projectId: 'book',
      bookTitle: 'Север',
      status: 'frozen',
      at: 11,
    });
    assert.equal(frozen[0]?.title, '«Север» заморожена');
    assert.notEqual(frozen[0]?.eventKey, rows[0]?.eventKey);
  });

  it('сводка за московский день считает людей и прячет их id', () => {
    assert.equal(digestDay(new Date('2026-11-22T20:30:00.000Z')), '2026-11-22');
    assert.equal(digestDay(new Date('2026-11-22T21:30:00.000Z')), '2026-11-23');

    let body = applyDigest('', 'likes', 'a', true) ?? '';
    assert.equal(applyDigest(body, 'likes', 'a', true), body);
    assert.equal(applyDigest(body, 'likes', 'zzz', false), body);
    body = applyDigest(body, 'likes', 'a', true) ?? '';
    body = applyDigest(body, 'likes', 'b', true) ?? '';
    body = applyDigest(body, 'reading', 'c', true) ?? '';
    assert.equal(publicNoticeBody(body), '2 лайка · 1 человек читает');
    assert.equal(body.includes('a') || body.includes('"c"'), true);
    assert.equal(publicNoticeBody(body).includes('a'), false);
    assert.equal(digestHeading('Север'), 'Отметки «Север»');

    body = applyDigest(body, 'likes', 'b', false) ?? '';
    assert.equal(publicNoticeBody(body), '1 лайк · 1 человек читает');
    body = applyDigest(body, 'reactions', 'd', true) ?? '';
    assert.equal(publicNoticeBody(body), '1 лайк · 1 человек читает · 1 реакция');
    assert.equal(publicNoticeBody(applyDigest(body, 'likes', 'a', false) ?? ''), '1 человек читает · 1 реакция');
    const cleared = applyDigest('', 'reading', 'c', true) ?? '';
    assert.equal(applyDigest(cleared, 'reading', 'c', false), null);

    const many = ['u1', 'u2', 'u3', 'u4', 'u5'].reduce((acc, id) => applyDigest(acc, 'likes', id, true) ?? '', '');
    assert.equal(publicNoticeBody(many), '5 лайков');
    const eleven = Array.from({ length: 11 }, (_, i) => `u${i}`).reduce((acc, id) => applyDigest(acc, 'reactions', id, true) ?? '', '');
    assert.equal(publicNoticeBody(eleven), '11 реакций');
  });
});
