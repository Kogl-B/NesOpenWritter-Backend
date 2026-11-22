import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { scoreChapters, type AiChapterRow } from './aiMarks.js';

function chapter(id: string, flags: Partial<AiChapterRow> = {}): AiChapterRow {
  return {
    id,
    parentId: null,
    kind: 'chapter',
    aiCreated: false,
    aiReviewed: false,
    ...flags,
  };
}

describe('scoreChapters', () => {
  it('десять глав без создания дают 100%', () => {
    const rows = Array.from({ length: 10 }, (_, index) => chapter(`c${index}`));
    const score = scoreChapters(rows);
    assert.equal(score.chapters, 10);
    assert.equal(score.manualCreated, 10);
    assert.equal(score.createdPercent, 100);
  });

  it('проверка в девяти главах из десяти даёт 10%', () => {
    const rows = Array.from({ length: 10 }, (_, index) => chapter(`c${index}`, { aiReviewed: index < 9 }));
    const score = scoreChapters(rows);
    assert.equal(score.manualReviewed, 1);
    assert.equal(score.reviewedPercent, 10);
    assert.equal(score.createdPercent, 100);
  });

  it('сцена с созданием ИИ помечает родительскую главу', () => {
    const score = scoreChapters([
      chapter('c1'),
      chapter('s1', { parentId: 'c1', kind: 'scene', aiCreated: true }),
    ]);
    assert.equal(score.chapters, 1);
    assert.equal(score.manualCreated, 0);
    assert.equal(score.createdPercent, 0);
  });
});
