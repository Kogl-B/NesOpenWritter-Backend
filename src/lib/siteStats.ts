import { prisma } from './prisma.js';
import { dayKey } from './traffic.js';

function num(value: unknown): number {
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'number') return value;
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function round1(part: number, whole: number): number {
  if (whole <= 0) return 0;
  return Math.round((part / whole) * 10) / 10;
}

interface ScalarRow {
  books: number;
  published: number;
  books30: number;
  users30: number;
  chapters: number;
  scenes: number;
  chars: number;
  words: number;
  comments: number;
  commenters: number;
  commented_books: number;
  blog_comments: number;
  blog_commenters: number;
  blog_posts: number;
  likes: number;
  favorites: number;
  reading_shelf: number;
  done_shelf: number;
  follows: number;
  subscriptions: number;
  readers: number;
  chapter_reads: number;
  avg_percent: number;
}

interface NamedCount {
  projectId: string;
  name: string;
  readers: number;
  avg: number;
  chars: number;
}

export async function loadSiteStats() {
  const since30 = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const from14 = dayKey(new Date(Date.now() - 13 * 24 * 60 * 60 * 1000));
  const from7 = dayKey(new Date(Date.now() - 6 * 24 * 60 * 60 * 1000));
  const [scalarRows, textAvgRows, planRows, metricRows, ads, topBookRows, topChapterRows, topReaderRows] = await Promise.all([
    prisma.$queryRaw<ScalarRow[]>`
      SELECT
        (SELECT COUNT(*)::int FROM projects) AS books,
        (SELECT COUNT(*)::int FROM projects WHERE COALESCE(settings #>> '{catalog,published}', '') = 'true') AS published,
        (SELECT COUNT(*)::int FROM projects WHERE "createdAt" >= ${since30}) AS books30,
        (SELECT COUNT(*)::int FROM users WHERE "createdAt" >= ${since30}) AS users30,
        (SELECT COUNT(*)::int FROM chapters WHERE kind = 'chapter') AS chapters,
        (SELECT COUNT(*)::int FROM chapters WHERE kind = 'scene') AS scenes,
        (SELECT COALESCE(SUM("charCount"), 0)::int FROM chapters) AS chars,
        (SELECT COALESCE(SUM("wordCount"), 0)::int FROM chapters) AS words,
        (SELECT COUNT(*)::int FROM book_comments) AS comments,
        (SELECT COUNT(DISTINCT "userId")::int FROM book_comments) AS commenters,
        (SELECT COUNT(DISTINCT "projectId")::int FROM book_comments) AS commented_books,
        (SELECT COUNT(*)::int FROM blog_comments) AS blog_comments,
        (SELECT COUNT(DISTINCT "userId")::int FROM blog_comments) AS blog_commenters,
        (SELECT COUNT(*)::int FROM blog_posts WHERE published) AS blog_posts,
        (SELECT COUNT(*)::int FROM book_reactions WHERE liked) AS likes,
        (SELECT COUNT(*)::int FROM book_reactions WHERE favorite) AS favorites,
        (SELECT COUNT(*)::int FROM book_reactions WHERE shelf = 'reading') AS reading_shelf,
        (SELECT COUNT(*)::int FROM book_reactions WHERE shelf = 'done') AS done_shelf,
        (SELECT COUNT(*)::int FROM author_follows) AS follows,
        (SELECT COUNT(*)::int FROM author_subscriptions) AS subscriptions,
        (SELECT COUNT(DISTINCT "userId")::int FROM read_progress) AS readers,
        (SELECT COUNT(*)::int FROM read_progress) AS chapter_reads,
        (SELECT COALESCE(ROUND(AVG(percent)), 0)::int FROM read_progress) AS avg_percent
    `,
    prisma.$queryRaw<Array<{ avg_chars: number; avg_words: number }>>`
      SELECT COALESCE(ROUND(AVG(chars)), 0)::int AS avg_chars,
             COALESCE(ROUND(AVG(words)), 0)::int AS avg_words
      FROM (
        SELECT SUM("charCount") AS chars, SUM("wordCount") AS words
        FROM chapters
        GROUP BY "projectId"
        HAVING SUM("charCount") > 0
      ) sized
    `,
    prisma.user.groupBy({ by: ['plan'], _count: true }),
    prisma.dailyMetric.findMany({ where: { day: { gte: from14 } } }),
    prisma.houseAd.findMany({ orderBy: { sort: 'asc' } }),
    prisma.$queryRaw<NamedCount[]>`
      SELECT rp."projectId" AS "projectId",
             COALESCE(p.name, 'Книга удалена') AS name,
             COUNT(DISTINCT rp."userId")::int AS readers,
             COALESCE(ROUND(AVG(rp.percent)), 0)::int AS avg,
             COALESCE(SUM(rp."charsSeen"), 0)::int AS chars
      FROM read_progress rp
      LEFT JOIN projects p ON p.id = rp."projectId"
      GROUP BY rp."projectId", p.name
      ORDER BY readers DESC, chars DESC
      LIMIT 8
    `,
    prisma.$queryRaw<Array<{ chapterId: string; projectId: string; title: string; book: string; readers: number; avg: number }>>`
      SELECT rp."chapterId" AS "chapterId",
             rp."projectId" AS "projectId",
             COALESCE(c.title, 'Глава удалена') AS title,
             COALESCE(p.name, 'Книга удалена') AS book,
             COUNT(DISTINCT rp."userId")::int AS readers,
             COALESCE(ROUND(AVG(rp.percent)), 0)::int AS avg
      FROM read_progress rp
      LEFT JOIN chapters c ON c.id = rp."chapterId"
      LEFT JOIN projects p ON p.id = rp."projectId"
      GROUP BY rp."chapterId", rp."projectId", c.title, p.name
      ORDER BY readers DESC, avg DESC
      LIMIT 8
    `,
    prisma.$queryRaw<Array<{ userId: string; chapters: number; avg: number; chars: number }>>`
      SELECT "userId" AS "userId",
             COUNT(*)::int AS chapters,
             COALESCE(ROUND(AVG(percent)), 0)::int AS avg,
             COALESCE(SUM("charsSeen"), 0)::int AS chars
      FROM read_progress
      GROUP BY "userId"
      ORDER BY chars DESC, chapters DESC
      LIMIT 8
    `,
  ]);
  const row = scalarRows[0];
  const books = num(row?.books);
  const published = num(row?.published);
  const comments = num(row?.comments);
  const commenters = num(row?.commenters);
  const blogComments = num(row?.blog_comments);
  const blogCommenters = num(row?.blog_commenters);
  const blogPosts = num(row?.blog_posts);
  const chars = num(row?.chars);
  const words = num(row?.words);
  const readerIds = topReaderRows.map((item) => item.userId);
  const readerUsers = readerIds.length
    ? await prisma.user.findMany({
      where: { id: { in: readerIds } },
      select: { id: true, name: true, email: true },
    })
    : [];
  const readerById = new Map(readerUsers.map((user) => [user.id, user]));
  let views7 = 0;
  let uniques7 = 0;
  let views14 = 0;
  let adShows7 = 0;
  let adClicks7 = 0;
  const dayMap = new Map<string, { views: number; uniques: number; adShows: number; adClicks: number }>();
  const areaMap = new Map<string, number>();
  const adMap = new Map<string, { shows7: number; clicks7: number; shows30: number; clicks30: number }>();
  for (const metric of metricRows) {
    const total = num(metric.total);
    const fresh = metric.day >= from7;
    if (metric.kind === 'view') {
      views14 += total;
      if (fresh) views7 += total;
      areaMap.set(metric.bucket, (areaMap.get(metric.bucket) ?? 0) + total);
      const day = dayMap.get(metric.day) ?? { views: 0, uniques: 0, adShows: 0, adClicks: 0 };
      day.views += total;
      dayMap.set(metric.day, day);
    } else if (metric.kind === 'unique') {
      if (fresh) uniques7 += total;
      const day = dayMap.get(metric.day) ?? { views: 0, uniques: 0, adShows: 0, adClicks: 0 };
      day.uniques += total;
      dayMap.set(metric.day, day);
    } else if (metric.kind === 'ad_show' || metric.kind === 'ad_click') {
      const slot = adMap.get(metric.bucket) ?? { shows7: 0, clicks7: 0, shows30: 0, clicks30: 0 };
      if (metric.kind === 'ad_show') {
        slot.shows30 += total;
        if (fresh) {
          slot.shows7 += total;
          adShows7 += total;
        }
        const day = dayMap.get(metric.day) ?? { views: 0, uniques: 0, adShows: 0, adClicks: 0 };
        day.adShows += total;
        dayMap.set(metric.day, day);
      } else {
        slot.clicks30 += total;
        if (fresh) {
          slot.clicks7 += total;
          adClicks7 += total;
        }
        const day = dayMap.get(metric.day) ?? { views: 0, uniques: 0, adShows: 0, adClicks: 0 };
        day.adClicks += total;
        dayMap.set(metric.day, day);
      }
      adMap.set(metric.bucket, slot);
    }
  }
  const plans = new Map<string, number>();
  for (const plan of planRows) {
    const id = plan.plan && plan.plan.trim() ? plan.plan : 'test';
    plans.set(id, (plans.get(id) ?? 0) + plan._count);
  }
  return {
    books,
    published,
    drafts: Math.max(0, books - published),
    books30: num(row?.books30),
    users30: num(row?.users30),
    chapters: num(row?.chapters),
    scenes: num(row?.scenes),
    chars,
    words,
    avgChars: books > 0 ? Math.round(chars / books) : 0,
    avgWords: books > 0 ? Math.round(words / books) : 0,
    avgCharsWithText: num(textAvgRows[0]?.avg_chars),
    avgWordsWithText: num(textAvgRows[0]?.avg_words),
    comments,
    commenters,
    commentedBooks: num(row?.commented_books),
    avgCommentsPerPublished: round1(comments, published),
    avgCommentsPerCommenter: round1(comments, commenters),
    blogComments,
    blogCommenters,
    blogPosts,
    avgBlogCommentsPerPost: round1(blogComments, blogPosts),
    avgBlogCommentsPerCommenter: round1(blogComments, blogCommenters),
    likes: num(row?.likes),
    favorites: num(row?.favorites),
    readingShelf: num(row?.reading_shelf),
    doneShelf: num(row?.done_shelf),
    follows: num(row?.follows),
    subscriptions: num(row?.subscriptions),
    readers: num(row?.readers),
    chapterReads: num(row?.chapter_reads),
    avgReadPercent: num(row?.avg_percent),
    plans: [...plans.entries()].map(([plan, count]) => ({ plan, count })).sort((a, b) => b.count - a.count),
    views7,
    uniques7,
    views14,
    adShows7,
    adClicks7,
    days: [...dayMap.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([day, value]) => ({ day, ...value })),
    areas: [...areaMap.entries()]
      .map(([area, views]) => ({ area, views }))
      .sort((a, b) => b.views - a.views),
    ads: ads.map((ad) => {
      const hits = adMap.get(ad.id) ?? { shows7: 0, clicks7: 0, shows30: 0, clicks30: 0 };
      return {
        id: ad.id,
        title: ad.title,
        body: ad.body,
        href: ad.href,
        enabled: ad.enabled,
        ...hits,
      };
    }),
    topBooks: topBookRows.map((item) => ({
      projectId: item.projectId,
      name: item.name,
      readers: num(item.readers),
      avgPercent: num(item.avg),
      charsSeen: num(item.chars),
    })),
    topChapters: topChapterRows.map((item) => ({
      chapterId: item.chapterId,
      projectId: item.projectId,
      title: item.title,
      book: item.book,
      readers: num(item.readers),
      avgPercent: num(item.avg),
    })),
    topReaders: topReaderRows.map((item) => {
      const user = readerById.get(item.userId);
      return {
        userId: item.userId,
        name: user?.name ?? '',
        email: user?.email ?? '',
        chapters: num(item.chapters),
        avgPercent: num(item.avg),
        charsSeen: num(item.chars),
      };
    }),
  };
}

export async function loadBookReading(projectId: string) {
  const project = await prisma.project.findUnique({ where: { id: projectId }, select: { id: true, name: true } });
  if (!project) return null;
  const [chapters, totals] = await Promise.all([
    prisma.$queryRaw<Array<{
      id: string;
      title: string;
      kind: string;
      orderIndex: number;
      charCount: number;
      readers: number;
      avg: number;
      chars: number;
    }>>`
      SELECT c.id, c.title, c.kind, c."orderIndex" AS "orderIndex", c."charCount" AS "charCount",
             COUNT(rp."userId")::int AS readers,
             COALESCE(ROUND(AVG(rp.percent)), 0)::int AS avg,
             COALESCE(SUM(rp."charsSeen"), 0)::int AS chars
      FROM chapters c
      JOIN read_progress rp ON rp."chapterId" = c.id
      WHERE c."projectId" = ${projectId}
      GROUP BY c.id
      ORDER BY readers DESC, c."orderIndex" ASC
      LIMIT 80
    `,
    prisma.$queryRaw<Array<{ total: number; touched: number }>>`
      SELECT COUNT(*)::int AS total,
             COUNT(*) FILTER (
               WHERE EXISTS (SELECT 1 FROM read_progress rp WHERE rp."chapterId" = c.id)
             )::int AS touched
      FROM chapters c
      WHERE c."projectId" = ${projectId}
    `,
  ]);
  const total = num(totals[0]?.total);
  const touched = num(totals[0]?.touched);
  return {
    projectId: project.id,
    name: project.name,
    totalChapters: total,
    touchedChapters: touched,
    unreadChapters: Math.max(0, total - touched),
    chapters: chapters.map((chapter) => ({
      id: chapter.id,
      title: chapter.title,
      kind: chapter.kind,
      orderIndex: num(chapter.orderIndex),
      charCount: num(chapter.charCount),
      readers: num(chapter.readers),
      avgPercent: num(chapter.avg),
      charsSeen: num(chapter.chars),
    })),
  };
}

export async function loadReaderStats(email: string) {
  const user = await prisma.user.findFirst({
    where: { email: { equals: email.trim(), mode: 'insensitive' } },
    select: { id: true, name: true, email: true },
  });
  if (!user) return null;
  const rows = await prisma.$queryRaw<Array<{
    chapterId: string;
    title: string;
    projectId: string;
    book: string;
    percent: number;
    charsSeen: number;
    charCount: number;
  }>>`
    SELECT c.id AS "chapterId",
           c.title,
           c."projectId" AS "projectId",
           p.name AS book,
           rp.percent,
           rp."charsSeen" AS "charsSeen",
           c."charCount" AS "charCount"
    FROM read_progress rp
    JOIN chapters c ON c.id = rp."chapterId"
    JOIN projects p ON p.id = rp."projectId"
    WHERE rp."userId" = ${user.id}
    ORDER BY rp."updatedAt" DESC
    LIMIT 80
  `;
  const books = new Set(rows.map((row) => row.projectId));
  const percents = rows.map((row) => num(row.percent));
  return {
    userId: user.id,
    name: user.name ?? '',
    email: user.email,
    books: books.size,
    chapters: rows.length,
    avgPercent: percents.length ? Math.round(percents.reduce((sum, value) => sum + value, 0) / percents.length) : 0,
    charsSeen: rows.reduce((sum, row) => sum + num(row.charsSeen), 0),
    rows: rows.map((row) => ({
      chapterId: row.chapterId,
      title: row.title,
      projectId: row.projectId,
      book: row.book,
      percent: num(row.percent),
      charsSeen: num(row.charsSeen),
      charCount: num(row.charCount),
    })),
  };
}
