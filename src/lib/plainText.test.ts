import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { countPlainText } from './plainText.js';

describe('countPlainText', () => {
  it('считает символы и слова видимого текста', () => {
    const doc = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Раз два' }] },
        { type: 'heading', content: [{ type: 'text', text: '  три' }] },
      ],
    };
    assert.deepEqual(countPlainText(doc), { words: 3, chars: 12 });
  });

  it('пустое и кривое содержимое даёт нули', () => {
    assert.deepEqual(countPlainText(null), { words: 0, chars: 0 });
    assert.deepEqual(countPlainText({ type: 'doc' }), { words: 0, chars: 0 });
  });
});
