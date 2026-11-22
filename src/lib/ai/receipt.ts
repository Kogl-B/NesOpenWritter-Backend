import { MODEL_PRESETS, type ModelPrices } from './deepseek.js';

export interface ReceiptSplit {
  inputMicros: number;
  cacheMicros: number;
  outputMicros: number;
}

/** Делит уже записанную стоимость на вход без кэша, попадание в кэш и ответ. Части сходятся с итогом. */
export function splitReceipt(input: {
  cacheMissTokens: number;
  cacheHitTokens: number;
  completionTokens: number;
  costUsdMicros: number;
  prices: ModelPrices;
}): ReceiptSplit {
  const cost = Number.isFinite(input.costUsdMicros) ? Math.max(0, Math.round(input.costUsdMicros)) : 0;
  const weightMiss = Math.max(0, input.cacheMissTokens) * input.prices.inputMissUsdPerM;
  const weightHit = Math.max(0, input.cacheHitTokens) * input.prices.inputHitUsdPerM;
  const weightOut = Math.max(0, input.completionTokens) * input.prices.outputUsdPerM;
  const weight = weightMiss + weightHit + weightOut;
  if (cost === 0 || weight <= 0) {
    return { inputMicros: 0, cacheMicros: 0, outputMicros: cost };
  }
  const inputMicros = Math.round((cost * weightMiss) / weight);
  const cacheMicros = Math.round((cost * weightHit) / weight);
  return {
    inputMicros,
    cacheMicros,
    outputMicros: cost - inputMicros - cacheMicros,
  };
}

/** Тариф DeepSeek для квитанции. Для картинок null: их цена хранится одной суммой. */
export function pricesForUsage(
  provider: string,
  model: string,
  providers: Array<{ provider: string } & ModelPrices>,
): ModelPrices | null {
  if (provider !== 'deepseek') return null;
  const found = providers.find((row) => row.provider === provider);
  if (found) {
    return {
      inputMissUsdPerM: found.inputMissUsdPerM,
      inputHitUsdPerM: found.inputHitUsdPerM,
      outputUsdPerM: found.outputUsdPerM,
    };
  }
  return MODEL_PRESETS[model]?.prices ?? MODEL_PRESETS['deepseek-flash']?.prices ?? null;
}
