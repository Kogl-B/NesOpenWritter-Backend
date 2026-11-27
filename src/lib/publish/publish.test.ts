import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { discordPayload, sponsrPayload, telegramUrl, vkParams, vkUrl } from './payload.js';
import { announcement, chapterBlocks, sponsrText, sponsrTitle } from './text.js';
import { bookIsPublished, chapterIsHidden, hideMetadata, revealMetadata } from './visibility.js';
import { footnoteLines, projectFootnotes } from '../footnoteText.js';
import { findDirectoryReference } from '../worldDirectory.js';
import { readerPages } from '../protectedReader.js';

const doc = {
  type: 'doc',
  content: [
    { type: 'paragraph', content: [{ type: 'text', text: 'Первая строка' }] },
    { type: 'paragraph', content: [{ type: 'text', text: 'Вторая <b>' }] },
    { type: 'paragraph', content: [{ type: 'text', text: '   ' }] },
  ],
};

describe('chapter text', () => {
  it('размещает ссылку на справочник внутри защищённой страницы без её текста и полей', () => {
    const id = '95a3e095-e698-4f05-928c-a6c7b3ece649';
    const attrs = { id, tableId: 'table-1', rowId: 'row-3', label: 'Описание маяка', fields: ['description'] };
    const chapter = { type: 'doc', content: [{ type: 'paragraph', content: [
      { type: 'text', text: 'Герой увидел маяк.' },
      { type: 'directoryReference', attrs },
    ] }] };
    assert.deepEqual(findDirectoryReference(chapter, id), attrs);
    assert.equal(findDirectoryReference(chapter, 'another-id'), undefined);
    const page = readerPages('manuscript-directory-test', chapter)[0];
    assert.equal(page?.kind, 'text');
    if (page?.kind !== 'text') return;
    assert.match(page.lines.join(' '), /\[Справка\]/);
    assert.equal(page.references[0]?.id, id);
    assert.ok((page.references[0]?.width ?? 0) > 0);
    assert.ok(!JSON.stringify(page).includes(attrs.label));
  });
  it('сохраняет новые и прежние сноски в читаемом виде для защищённой читалки и EPUB', () => {
    const chapter = { type: 'doc', content: [{ type: 'paragraph', content: [
      { type: 'text', text: 'Начало', marks: [{ type: 'footnote', attrs: { text: 'Старый источник' } }] },
      { type: 'text', text: ' и конец' },
      { type: 'footnoteReference', attrs: { id: 'n2', text: 'Новый источник' } },
    ] }] };
    const notes: string[] = [];
    assert.deepEqual(chapterBlocks(projectFootnotes(chapter, notes)), ['Начало[1] и конец[2]']);
    assert.deepEqual(footnoteLines(notes), ['Сноски', '1. Старый источник', '2. Новый источник']);
    assert.deepEqual(chapterBlocks(chapter), ['Начало и конец']);
  });
  it('берёт непустые абзацы и экранирует HTML Sponsr', () => {
    const blocks = chapterBlocks(doc);
    assert.deepEqual(blocks, ['Первая строка', 'Вторая <b>']);
    const html = sponsrText(blocks, 'https://example.com/read/1?c=2');
    assert.match(html, /Читать на сайте/);
    assert.match(html, /Вторая &lt;b&gt;/);
    assert.equal(html.includes('<b>'), false);
  });

  it('укладывает анонс в лимит и оставляет ссылку', () => {
    const text = announcement({
      book: 'Книга',
      chapter: 'Глава',
      text: 'слово '.repeat(800),
      url: 'https://example.com/read/book?c=ch',
      limit: 200,
    });
    assert.ok(text.length <= 200);
    assert.match(text, /https:\/\/example\.com\/read\/book\?c=ch$/);
    assert.match(text, /^«Книга» — Глава/);
  });

  it('дополняет короткий заголовок Sponsr до четырёх знаков', () => {
    assert.equal(sponsrTitle('Я', 'Книга').length >= 4, true);
    assert.equal(sponsrTitle('Длинный заголовок', 'Книга'), 'Длинный заголовок');
  });
});

describe('payloads', () => {
  it('ставит from_group только для сообщества', () => {
    const group = vkParams({ token: 'secret-token', ownerId: '-10', message: 'привет' });
    assert.equal(group.get('from_group'), '1');
    assert.equal(group.get('owner_id'), '-10');
    assert.equal(group.get('message'), 'привет');
    const user = vkParams({ token: 'secret-token', ownerId: '10', message: 'привет' });
    assert.equal(user.get('from_group'), null);
    assert.equal(vkUrl('-10', '99'), 'https://vk.com/wall-10_99');
  });

  it('собирает ссылку Telegram и глушит @everyone в Discord', () => {
    assert.equal(telegramUrl('@channel', '5'), 'https://t.me/channel/5');
    assert.equal(telegramUrl('-100123', '5'), 'https://t.me/c/123/5');
    const body = sponsrPayload({
      title: 'Глава первая',
      book: 'Книга',
      blocks: ['Текст'],
      url: 'https://example.com/read/1?c=2',
      date: '2026-11-22',
    });
    assert.equal(body.date, '2026-11-22');
    assert.equal(body.is_markdown, false);
    assert.equal(discordPayload('всем @everyone').content.includes('@everyone'), false);
  });
});

describe('visibility', () => {
  it('скрывает только явное public false', () => {
    assert.equal(chapterIsHidden(null), false);
    assert.equal(chapterIsHidden({}), false);
    assert.equal(chapterIsHidden({ public: true }), false);
    assert.equal(chapterIsHidden({ public: false }), true);
    assert.equal(bookIsPublished({ catalog: { published: true } }), true);
    assert.equal(bookIsPublished({ catalog: { published: 'true' } }), false);
    assert.equal(revealMetadata({ audio: 'x', public: false }).public, true);
    assert.equal(hideMetadata({ audio: 'x', public: true }).public, false);
    assert.equal(hideMetadata({ audio: 'x' }).audio, 'x');
  });
});
