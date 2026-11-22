import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { boostyAttachments, boostyBlogSlug, boostyDraftForm, boostyImageFrom, boostyTextBlocks, createdPostFrom } from './boostyPost.js';

describe('boosty post', () => {
  it('берёт имя блога из адреса', () => {
    assert.equal(boostyBlogSlug('https://boosty.to/openwritter'), 'openwritter');
    assert.throws(() => boostyBlogSlug('https://example.com/openwritter'), /адреса блога/);
  });

  it('собирает бесплатный черновик из абзацев', () => {
    const form = boostyDraftForm({ title: '  Проверка  ', paragraphs: ['Первая строка', '', 'Вторая'] });
    assert.equal(form.get('title'), 'Проверка');
    assert.equal(form.get('price'), '0');
    assert.equal(form.get('teaser_data'), '[]');
    const blocks = JSON.parse(form.get('data') ?? '[]') as Array<{ content: string; modificator: string }>;
    assert.equal(blocks.length, 4);
    const first = blocks[0];
    const end = blocks[1];
    const third = blocks[2];
    if (!first || !end || !third) throw new Error('нет блоков');
    assert.equal(JSON.parse(first.content)[0], 'Первая строка');
    assert.equal(end.modificator, 'BLOCK_END');
    assert.equal(JSON.parse(third.content)[0], 'Вторая');
  });

  it('вкладывает фото и ссылку', () => {
    const image = {
      id: '11111111-2222-4333-8444-555555555555',
      url: 'https://images.boosty.to/image/11111111-2222-4333-8444-555555555555',
      width: 32,
      height: 32,
      size: 100,
    };
    const form = boostyDraftForm({
      title: 'С фото',
      paragraphs: ['Текст'],
      images: [image],
      links: [{ url: 'https://boosty.to/openwritter', title: 'Блог' }],
    });
    const blocks = JSON.parse(form.get('data') ?? '[]') as Array<{ type: string; id?: string; url?: string }>;
    assert.equal(blocks.some((block) => block.type === 'image' && block.id === image.id), true);
    assert.equal(blocks.some((block) => block.type === 'link' && block.url === 'https://boosty.to/openwritter'), true);
    assert.throws(() => boostyDraftForm({
      title: 'Плохая ссылка',
      paragraphs: [],
      links: [{ url: 'http://boosty.to/openwritter' }],
    }), /https/);
  });

  it('читает загруженное фото и вложения поста', () => {
    const image = boostyImageFrom({ data: { id: '11111111-2222-4333-8444-555555555555', width: 32, height: 16, size: 80 } });
    assert.equal(image.url, 'https://images.boosty.to/image/11111111-2222-4333-8444-555555555555');
    const found = boostyAttachments({
      id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      data: [
        { type: 'image', id: image.id },
        { type: 'link', url: 'https://boosty.to/openwritter' },
      ],
    });
    assert.deepEqual(found, { images: [image.id], links: ['https://boosty.to/openwritter'] });
  });

  it('отклоняет пустой текст', () => {
    assert.deepEqual(boostyTextBlocks(['  ']), []);
    assert.throws(() => boostyDraftForm({ title: 'Заголовок', paragraphs: [' '] }), /текст поста/);
  });

  it('читает пост из обёртки публикации', () => {
    const post = createdPostFrom({
      data: { post: { id: '11111111-2222-4333-8444-555555555555', title: 'Проверка', isPublished: true } },
    }, 'openwritter');
    assert.equal(post.url, 'https://boosty.to/openwritter/posts/11111111-2222-4333-8444-555555555555');
    assert.equal(post.published, true);
  });
});
