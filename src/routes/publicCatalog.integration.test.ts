import assert from 'node:assert/strict';
import { test } from 'node:test';

import { filterCatalogBooks, type CatalogQuery, type SearchableBook } from '../lib/catalogSearch.js';
import { expandGenre } from '../lib/genres.js';
import { nowpaymentsSignature } from '../lib/nowpayments.js';

type TestBook = SearchableBook & { id: string };
const databaseUrl = process.env.CATALOG_TEST_DATABASE_URL;
const origin = 'http://localhost:8098';
const edgeToken = 'catalog-qa-edge-key';
const ipnSecret = 'catalog-qa-ipn-key';

test('public catalog, request identity and quotas on isolated PostgreSQL', async (t) => {
  assert.ok(databaseUrl);
  assert.match(new URL(databaseUrl).pathname, /^\/ow_catalog_qa_[a-z0-9_]+$/);
  Object.assign(process.env, {
    DATABASE_URL: databaseUrl, NODE_ENV: 'test', LOG_LEVEL: 'fatal',
    BETTER_AUTH_URL: origin, FRONTEND_URL: origin, CORS_ORIGIN: origin,
    BETTER_AUTH_SECRET: 'catalog-test-only-not-a-production-secret',
    REQUIRE_EMAIL_VERIFICATION: 'false', GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '',
    RESEND_API_KEY: '', SENTRY_DSN: '', GEO_EDGE_TOKEN: edgeToken, GEO_DEV_COUNTRY: '',
    NOWPAYMENTS_IPN_SECRET: ipnSecret,
  });
  const { buildApp } = await import('../app.js');
  const { prisma } = await import('../lib/prisma.js');
  const { selectRequestNetwork } = await import('../lib/requestNetwork.js');
  const app = await buildApp();

  try {
    const reader = await app.inject({ method: 'POST', url: '/api/auth/sign-up/email',
      headers: { origin }, payload: { email: 'catalog-reader@example.invalid', password: 'CatalogReaderTest123!', name: 'Читатель' } });
    assert.equal(reader.statusCode, 200);
    const cookie = reader.cookies.map(({ name, value }) => name + '=' + value).join('; ');
    assert.ok(cookie);
    const readerId = reader.json().user.id as string;
    const author = await prisma.user.create({ data: { email: 'catalog-author@example.invalid', name: 'Анна Ветрова' } });
    const hiddenAuthor = await prisma.user.create({ data: { email: 'catalog-hidden@example.invalid', name: 'Скрытый автор' } });

    const fixture: TestBook[] = Array.from({ length: 68 }, (_, i) => ({
      id: `catalog-${String(i).padStart(3, '0')}`,
      title: i % 2 ? `Берег ${i}` : `Хроника ${i}`, authorName: (i === 60 ? hiddenAuthor.name : author.name) ?? 'Автор',
      description: i % 2 ? 'Море' : 'Северный ветер %_', cycle: i % 2 ? '' : 'Северный цикл',
      tags: i % 3 ? ['Драма', 'путешествие'] : ['Юмор'],
      genres: i % 2 ? ['hard-sf'] : ['custom-genre'],
      genreNames: i % 2 ? ['Твёрдая НФ'] : ['custom-genre'],
      words: 376 + 29 * i, views: i, likes: i % 4 ? 1 : 0, favorites: i % 5 ? 0 : 1,
      status: i % 2 ? 'complete' : 'writing',
      createdAt: new Date(Date.now() - i * 86_400_000).toISOString(),
      textUpdatedAt: new Date(Date.now() - i * 8_640_000).toISOString(),
    }));
    const blockedBook = fixture[66]!.id;
    const geoBook = fixture[67]!.id;
    await prisma.project.createMany({ data: fixture.map((b, i) => ({
      id: b.id, ownerId: i === 60 ? hiddenAuthor.id : author.id, name: b.title, description: b.description,
      createdAt: new Date(b.createdAt), updatedAt: new Date(b.textUpdatedAt),
      settings: { catalog: { published: i !== 64, cycle: b.cycle, status: b.status, tags: [...b.tags, 7], genres: b.genres } },
    })) });
    await prisma.chapter.createMany({ data: fixture.flatMap(b => [
      { projectId: b.id, title: 'Открытая', wordCount: b.words, updatedAt: new Date(b.textUpdatedAt) },
      { projectId: b.id, title: 'Закрытая', wordCount: 9999, metadata: { public: false } },
    ]) });
    await prisma.bookView.createMany({ data: fixture.flatMap(b => Array.from({ length: b.views }, () => ({ projectId: b.id }))) });
    await prisma.bookReaction.createMany({ data: fixture.map(b => ({
      projectId: b.id, userId: readerId, liked: b.likes === 1, favorite: b.favorites === 1,
    })) });
    await prisma.user.update({ where: { id: readerId }, data: { settings: {
      blockedAuthorIds: [hiddenAuthor.id], blockedBookIds: [blockedBook],
    } } });
    await prisma.geoBlock.create({ data: { kind: 'book', targetId: geoBook, countries: ['RU'] } });
    const headers = { 'x-ow-geo-token': edgeToken, 'x-ow-country': 'RU', 'x-ow-client-ip': '192.0.2.20' };
    const allPublished = fixture.filter((_, i) => i !== 64 && i !== 67);
    const visibleToReader = allPublished.filter((b) => b.id !== blockedBook && b.authorName !== hiddenAuthor.name);
    const ids = (books: Array<{ id: string }>) => books.map(b => b.id);

    await t.test('results agree with the existing filter logic across pages and visibility rules', async () => {
      const cases: CatalogQuery[] = [
        {}, { q: 'ВЕТЕР %_', excludeTag: 'юмор' }, { author: '  Ветрова  ', cycle: 'северный', status: 'writing' },
        { tag: 'ДРАМА,путеш', genre: 'sf', sort: 'likes' }, { genre: 'custom-genre', tag: 'custom', sort: 'updated' },
        { size: 'drabble', maxWords: '0', sort: 'words' }, { minPages: '4', maxPages: '6', sort: 'new' },
        { minWords: '381', maxWords: '2010', updatedDays: '3', sort: 'favorites' },
        { q: 'без совпадений' }, { status: 'complete,writing', genre: 'hard-sf,bad-genre' },
      ];
      for (const filters of cases) {
        const expected = filterCatalogBooks(visibleToReader, filters, expandGenre);
        for (const page of [1, 2]) {
          const query = new URLSearchParams({ ...filters, page: String(page) });
          const reply = await app.inject({ url: '/api/catalog/search?' + query, headers: { ...headers, cookie } });
          assert.equal(reply.statusCode, 200, reply.body.slice(0, 300));
          const actual = reply.json();
          assert.equal(actual.total, expected.length);
          assert.equal(actual.page, page);
          assert.equal(reply.headers['cache-control'], 'private, no-store');
          // For tied scores the SQL uses stable IDs, so compare against the full
          // candidate set and assert exact ordering on the distinct default ranking.
          if (!filters.sort && !filters.q) assert.deepEqual(ids(actual.books), ids(expected.slice((page - 1) * 48, page * 48)));
          else assert.deepEqual(ids(actual.books).sort(), ids(expected.slice((page - 1) * 48, page * 48)).sort());
        }
      }
    });

    await t.test('shelves and tops are bounded before cards are loaded', async () => {
      const response = await app.inject({ url: '/api/catalog/home', headers: { ...headers, cookie } });
      assert.equal(response.statusCode, 200, response.body.slice(0, 300));
      const home = response.json();
      assert.equal(home.shelves.popular.length, 12);
      assert.deepEqual(ids(home.shelves.popular), ids([...visibleToReader].sort((a, b) => b.views - a.views).slice(0, 12)));
      assert.ok(home.shelves.favorites.every((book: { favorite: boolean }) => book.favorite));
      const tops = await app.inject({ url: '/api/catalog/tops', headers });
      assert.equal(tops.statusCode, 200, tops.body.slice(0, 300));
      assert.equal(tops.json().byViews.length, 30);
      assert.deepEqual(ids(tops.json().byViews), ids([...allPublished].sort((a, b) => b.views - a.views).slice(0, 30)));
      assert.equal(tops.json().authors.reduce((sum: number, a: { books: number }) => sum + a.books, 0), allPublished.length);
    });

    await t.test('title relevance, reader-facing author search, and hidden publications', async () => {
      await prisma.blogProfile.create({ data: { authorId: author.id, nickname: 'ветрова_перо' } });
      await prisma.blogProfile.create({ data: { authorId: hiddenAuthor.id, nickname: 'скрытый-автор' } });
      const [exact, prefix, description] = await Promise.all([
        prisma.project.create({ data: { ownerId: author.id, name: 'Ёлка — Север', settings: { catalog: { published: true } } } }),
        prisma.project.create({ data: { ownerId: author.id, name: 'Ёлка Север и ночь', settings: { catalog: { published: true } } } }),
        prisma.project.create({ data: { ownerId: author.id, name: 'Другая книга', description: 'Лишь в описании: Ёлка Север', settings: { catalog: { published: true } } } }),
      ]);
      await prisma.bookView.createMany({ data: Array.from({ length: 25 }, () => ({ projectId: description.id })) });
      const get = async (path: string, query: Record<string, string>, authenticated = false) => {
        const result = await app.inject({ url: '/api/catalog/search' + path + '?' + new URLSearchParams(query),
          headers: authenticated ? { ...headers, cookie } : headers });
        assert.equal(result.statusCode, 200, result.body.slice(0, 350));
        assert.equal(result.headers['cache-control'], 'private, no-store');
        return result.json();
      };

      const relevant = await get('', { q: '  ЕЛКА   СЕВЕР  ' });
      assert.deepEqual(ids(relevant.books), [exact.id, prefix.id, description.id]);
      const reordered = await get('', { q: 'север елка' });
      assert.deepEqual(ids(reordered.books).slice(0, 2).sort(), [exact.id, prefix.id].sort());
      const explicitlyPopular = await get('', { q: 'елка север', sort: 'popular' });
      assert.equal(explicitlyPopular.books[0].id, description.id);
      const allWrittenByHandle = await get('', { q: '@ВЕТРОВА_ПЕРО' }, true);
      assert.ok(allWrittenByHandle.books.length > 0);
      assert.ok(allWrittenByHandle.books.every((book: { authorId: string }) => book.authorId === author.id));

      const publicAuthor = await get('/authors', { q: 'ветрова анна' }, true);
      const byNickname = await get('/authors', { q: '@ветрова_перо' }, true);
      assert.deepEqual(publicAuthor.authors, byNickname.authors);
      assert.deepEqual(publicAuthor.authors, [{
        id: author.id, name: author.name, nickname: 'ветрова_перо', image: null,
        books: visibleToReader.length + 3,
      }]);
      assert.equal((await get('/authors', { q: '@скрытый-автор' }, true)).total, 0);
      assert.equal((await get('/authors', { q: '@скрытый-автор' })).total, 1);
      assert.equal((await get('/authors', { q: 'Читатель' })).total, 0);
      const emptyPage = await get('/authors', { q: 'ветрова', page: '2' });
      assert.equal(emptyPage.total, 1);
      assert.deepEqual(emptyPage.authors, []);

      const profile = await app.inject({ url: '/api/catalog/authors/' + author.id, headers: { ...headers, cookie } });
      assert.equal(profile.statusCode, 200, profile.body.slice(0, 350));
      assert.equal(profile.json().author.books, publicAuthor.authors[0].books);
      assert.ok(profile.json().books.every((book: { authorId: string }) => book.authorId === author.id));
    });

    await t.test('client identity comes from the verified provider or the connected peer', () => {
      assert.deepEqual(selectRequestNetwork({ headers, edgeToken, peer: '192.0.2.1', railwayHttpIngress: true }),
        { address: '192.0.2.20', country: 'RU' });
      assert.deepEqual(selectRequestNetwork({ headers, edgeToken: '', peer: '::ffff:c000:201', railwayHttpIngress: false }),
        { address: '192.0.2.1', country: null });
      assert.deepEqual(selectRequestNetwork({ headers: { 'x-real-ip': '192.0.2.10' }, edgeToken, peer: '192.0.2.1', railwayHttpIngress: true }),
        { address: '192.0.2.10', country: null });
      assert.deepEqual(selectRequestNetwork({ headers: { 'x-real-ip': ['192.0.2.9', '192.0.2.10'] }, edgeToken, peer: '192.0.2.1', railwayHttpIngress: true }),
        { address: '192.0.2.1', country: null });
    });

    await t.test('quota returns Retry-After and leaves other clients and signed IPNs available', async () => {
      const remoteAddress = '192.0.2.25';
      for (let request = 0; request < 60; request++) {
        const result = await app.inject({ url: '/api/catalog/search?page=invalid', remoteAddress });
        assert.equal(result.statusCode, 400);
      }
      const limited = await app.inject({ url: '/api/catalog/search', remoteAddress });
      assert.equal(limited.statusCode, 429);
      assert.ok(Number(limited.headers['retry-after']) > 0);
      assert.equal((await app.inject({ url: '/api/catalog/search', remoteAddress: '192.0.2.26' })).statusCode, 200);
      const url = '/api/payments/nowpayments/webhook';
      const payload = { payment_status: 'finished' };
      assert.equal((await app.inject({ method: 'POST', url, remoteAddress, payload,
        headers: { 'x-nowpayments-sig': nowpaymentsSignature(payload, ipnSecret) } })).statusCode, 200);
      assert.equal((await app.inject({ method: 'POST', url, remoteAddress, payload,
        headers: { 'x-nowpayments-sig': 'invalid' } })).statusCode, 403);
    });
  } finally {
    await app.close();
    await prisma.$disconnect();
  }
});
