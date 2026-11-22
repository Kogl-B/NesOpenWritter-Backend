import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { MODEL_PRESETS } from './deepseek.js';
import { pricesForUsage, splitReceipt } from './receipt.js';

const flash = MODEL_PRESETS['deepseek-flash']?.prices;
if (!flash) throw new Error('нет тарифа deepseek-flash');

describe('квитанция операции', () => {
  it('делит стоимость ИИ-вставки на вход и ответ', () => {
    const parts = splitReceipt({
      cacheMissTokens: 2222,
      cacheHitTokens: 0,
      completionTokens: 1137,
      costUsdMicros: 3048,
      prices: flash,
    });
    assert.deepEqual(parts, { inputMicros: 1000, cacheMicros: 0, outputMicros: 2048 });
  });

  it('оставляет попадание в кэш отдельной суммой', () => {
    const parts = splitReceipt({
      cacheMissTokens: 0,
      cacheHitTokens: 1000,
      completionTokens: 0,
      costUsdMicros: 9,
      prices: flash,
    });
    assert.deepEqual(parts, { inputMicros: 0, cacheMicros: 9, outputMicros: 0 });
  });

  it('сводит части к нулю, когда стоимость нулевая', () => {
    const parts = splitReceipt({
      cacheMissTokens: 10,
      cacheHitTokens: 10,
      completionTokens: 10,
      costUsdMicros: 0,
      prices: flash,
    });
    assert.deepEqual(parts, { inputMicros: 0, cacheMicros: 0, outputMicros: 0 });
  });

  it('берёт тариф DeepSeek и не делит картинку', () => {
    assert.deepEqual(pricesForUsage('deepseek', 'deepseek-flash', []), flash);
    assert.equal(pricesForUsage('openai-image', 'gpt-image-2.5-flare', []), null);
  });
});
