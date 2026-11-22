export interface ModelPrices {
  inputMissUsdPerM: number;
  inputHitUsdPerM: number;
  outputUsdPerM: number;
}

/** Внепиковые цены официального тарифа DeepSeek, миллионные доли доллара за 1 млн токенов. */
export const MODEL_PRESETS: Record<string, { title: string; prices: ModelPrices }> = {
  'deepseek-flash': {
    title: 'DeepSeek Flash',
    prices: { inputMissUsdPerM: 150_000, inputHitUsdPerM: 3_000, outputUsdPerM: 600_000 },
  },
  'deepseek-v4-pro': {
    title: 'DeepSeek V4 Pro',
    prices: { inputMissUsdPerM: 660_000, inputHitUsdPerM: 22_000, outputUsdPerM: 1_980_000 },
  },
};

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

function readUsage(raw: unknown): TokenUsage {
  const usage = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const promptTokens = num(usage.prompt_tokens);
  const completionTokens = num(usage.completion_tokens);
  const cacheHitTokens = num(usage.prompt_cache_hit_tokens);
  const cacheMissTokens = num(usage.prompt_cache_miss_tokens) || Math.max(0, promptTokens - cacheHitTokens);
  const totalTokens = num(usage.total_tokens) || promptTokens + completionTokens;
  return { promptTokens, completionTokens, totalTokens, cacheHitTokens, cacheMissTokens };
}

/**
 * Пик DeepSeek: будни 01:00–04:00 и 06:00–10:00 UTC.
 * Китайские праздники в эту оценку не входят: в такой день цена может быть завышена вдвое.
 */
export function isPeakHour(now = new Date()): boolean {
  const day = now.getUTCDay();
  if (day === 0 || day === 6) return false;
  const hour = now.getUTCHours();
  return (hour >= 1 && hour < 4) || (hour >= 6 && hour < 10);
}

/** Цена для пользователя: себестоимость токенов, умноженная на наценку. По умолчанию ×3. */
export function withMarkup(realMicros: number, multiplier: number): number {
  const factor = Number.isInteger(multiplier) && multiplier >= 1 && multiplier <= 20 ? multiplier : 3;
  if (!Number.isFinite(realMicros) || realMicros <= 0) return 0;
  return Math.round(realMicros * factor);
}

export function costUsdMicros(usage: TokenUsage, prices: ModelPrices, peak: boolean, multiplier: number): number {
  const factor = peak ? Math.max(1, multiplier) : 1;
  const raw = usage.cacheMissTokens * prices.inputMissUsdPerM
    + usage.cacheHitTokens * prices.inputHitUsdPerM
    + usage.completionTokens * prices.outputUsdPerM;
  return Math.round((raw * factor) / 1_000_000);
}

async function postChat(url: string, apiKey: string, body: unknown, signal: AbortSignal): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal,
  });
}

export async function completeDeepSeek(input: {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  maxTokens: number;
  temperature: number;
  timeoutMs?: number;
}): Promise<{ text: string; usage: TokenUsage }> {
  const origin = new URL(input.baseUrl);
  if (origin.protocol !== 'https:') throw new Error('Адрес API должен начинаться с https://');
  const url = `${origin.origin}/chat/completions`;
  const base = {
    model: input.model,
    messages: input.messages,
    max_tokens: input.maxTokens,
    temperature: input.temperature,
    stream: false,
  };
  const signal = AbortSignal.timeout(input.timeoutMs ?? 45_000);
  let response = await postChat(url, input.apiKey, { ...base, thinking: { type: 'disabled' } }, signal);
  if (response.status === 400) {
    const probe = await response.text();
    if (/thinking/i.test(probe)) {
      response = await postChat(url, input.apiKey, base, AbortSignal.timeout(input.timeoutMs ?? 45_000));
    } else {
      throw new Error(deepSeekError(response.status, probe));
    }
  }
  if (!response.ok) {
    const body = await response.text();
    throw new Error(deepSeekError(response.status, body));
  }
  const payload = await response.json() as {
    choices?: Array<{ message?: { content?: string | null } }>;
    usage?: unknown;
  };
  const text = payload.choices?.[0]?.message?.content?.trim() ?? '';
  if (!text) throw new Error('DeepSeek вернул пустой ответ');
  return { text, usage: readUsage(payload.usage) };
}

function deepSeekError(status: number, body: string): string {
  const clean = body.replace(/\s+/g, ' ').slice(0, 240);
  return `DeepSeek ответил ${status}${clean ? `: ${clean}` : ''}`;
}
