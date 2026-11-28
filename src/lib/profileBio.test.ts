import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseProfileBioDocument, readProfileBio } from './profileBio.js';

test('profile bio uses known formatting and retains readable text', () => {
  const document = { type: 'doc', content: [{ type: 'paragraph', attrs: { textAlign: 'center', style: 'width:0' },
    content: [{ type: 'text', text: 'О себе', marks: [{ type: 'bold' }, { type: 'link', attrs: { href: 'ignored' } }] }],
  }] };
  assert.deepEqual(parseProfileBioDocument(document, 'О себе'), {
    type: 'doc', content: [{ type: 'paragraph', attrs: { textAlign: 'center' },
      content: [{ type: 'text', text: 'О себе', marks: [{ type: 'bold' }] }],
    }],
  });
});

test('profile bio falls back to plain text for legacy, stale, or unsupported content', () => {
  assert.deepEqual(readProfileBio({ bio: 'Давно пишу' }), { text: 'Давно пишу', document: null });
  assert.deepEqual(readProfileBio({ about: 'Новый текст', bioDocument: { text: 'Старый текст' } }),
    { text: 'Новый текст', document: null });
  assert.equal(parseProfileBioDocument({ type: 'doc', content: [{ type: 'image' }] }, ''), null);
  assert.equal(parseProfileBioDocument({ type: 'doc', content: [{ type: 'paragraph' }] }, 'Пропущен текст'), null);
});
