import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { assertKitUrl, chapterHtml, kitPackage } from './kit.js';

const doc = {
  type: 'doc',
  content: [
    {
      type: 'paragraph',
      content: [
        { type: 'text', text: 'Обычный ' },
        { type: 'text', text: 'жирный', marks: [{ type: 'bold' }] },
        { type: 'text', text: ' <script>' },
      ],
    },
    { type: 'blockquote', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Цитата' }] }] },
  ],
};

describe('kit text', () => {
  it('экранирует чужие теги и сохраняет жирный', () => {
    const html = chapterHtml(doc);
    assert.match(html, /<strong>жирный<\/strong>/);
    assert.match(html, /&lt;script&gt;/);
    assert.equal(html.includes('<script>'), false);
    assert.match(html, /<blockquote><p>Цитата<\/p><\/blockquote>/);
  });

  it('для Boosty отдаёт тизер и адрес блога', () => {
    const pack = kitPackage({
      platform: 'boosty',
      title: 'Глава',
      doc,
      bookUrl: 'https://boosty.to/author',
    });
    assert.equal(pack.openUrl, 'https://boosty.to/author');
    assert.ok(pack.teaser.length > 0);
    assert.match(pack.notes[1] ?? '', /подписчикам/);
  });

  it('для Wattpad сообщает длину, для Рулейта открывает сайт книги', () => {
    const wattpad = kitPackage({ platform: 'wattpad', title: 'Часть', doc });
    assert.match(wattpad.notes[0] ?? '', /слов/);
    assert.equal(wattpad.openUrl, 'https://www.wattpad.com/myworks');
    const rulate = kitPackage({ platform: 'rulate', title: 'Глава', doc });
    assert.match(rulate.notes[0] ?? '', /Рулейт/);
    assert.equal(rulate.openUrl, 'https://tl.rulate.ru/');
    assert.equal(
      kitPackage({ platform: 'rulate', title: 'Глава', doc, bookUrl: 'https://tl.rulate.ru/book/15' }).openUrl,
      'https://tl.rulate.ru/book/15',
    );
  });

  it('не принимает чужой сайт в адресе книги', () => {
    assert.throws(() => assertKitUrl('litnet', 'https://example.com/book'), /litnet\.com/);
    assert.throws(() => assertKitUrl('rulate', 'http://tl.rulate.ru/book/1'), /https/);
    assert.equal(
      assertKitUrl('author_today', 'https://author.today/work/15'),
      'https://author.today/work/15',
    );
  });
});
