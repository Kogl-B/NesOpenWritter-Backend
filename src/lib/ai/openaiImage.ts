/**
 * Прямой клиент GPT Image 2.5.
 * Контракт запроса и разбор ответа совпадают с модулем TISMOS
 * `app/services/openai_image.py`: два режима — Flare и Sunburst.
 */

export const OPENAI_IMAGE_MODELS = ['gpt-image-2.5-flare', 'gpt-image-2.5-sunburst'] as const;

export type OpenAIImageModel = (typeof OPENAI_IMAGE_MODELS)[number];

export const DEFAULT_OPENAI_IMAGE_MODEL: OpenAIImageModel = 'gpt-image-2.5-flare';

const LEGACY_MODELS = new Set(['gpt-image-2', 'gpt-image-2-2026-04-21']);

const SNAPSHOTS: Record<string, OpenAIImageModel> = {
  'gpt-image-2.5-flare-2026-09-08': 'gpt-image-2.5-flare',
  'gpt-image-2.5-sunburst-2026-09-08': 'gpt-image-2.5-sunburst',
};

export const OPENAI_IMAGE_MODEL_TITLES: Record<OpenAIImageModel, string> = {
  'gpt-image-2.5-flare': 'GPT Image 2.5 Flare',
  'gpt-image-2.5-sunburst': 'GPT Image 2.5 Sunburst',
};

export const IMAGE_SIZE_CHOICES = [
  '768x1024',
  '1024x1024',
  '1024x1536',
  '1536x1024',
  '1536x2048',
  '2048x2048',
  '816x816',
  '2048x1152',
  '3840x2160',
  '2160x3840',
  'auto',
] as const;

export const IMAGE_QUALITIES = ['low', 'medium', 'high', 'xhigh', 'max', 'auto'] as const;

/** Как в TISMOS: low · 1024×1024 · PNG. Рукопись потом ужимает картинку сама. */
export const DEFAULT_IMAGE_OPTIONS = {
  size: '1024x1024',
  quality: 'low',
  output_format: 'png',
  output_compression: 100,
  background: 'auto',
  moderation: 'auto',
} as const;

/** Минимум долларов на счёте ИИ до любой платной услуги. */
export const MIN_IMAGE_BALANCE_CENTS = 50;

/** Пустая строка значит, что услугу можно запускать. */
export function aiBalanceRefusal(cents: number): string | null {
  if (typeof cents === 'number' && Number.isFinite(cents) && cents >= MIN_IMAGE_BALANCE_CENTS) return null;
  return `Услуги ИИ доступны при балансе не меньше ${(MIN_IMAGE_BALANCE_CENTS / 100).toFixed(2)} $`;
}

export interface ImageOptions {
  model: string;
  size: string;
  quality: string;
  output_format: string;
  background: string;
  moderation: string;
  output_compression?: number;
}

export interface GeneratedImage {
  bytes: Buffer;
  mediaType: string;
  extension: string;
  requestId: string | null;
  usage: Record<string, unknown> | null;
}

export function isOpenAIImageModel(value: string): value is OpenAIImageModel {
  return (OPENAI_IMAGE_MODELS as readonly string[]).includes(value);
}

export function imageModelFamily(model: string): string {
  return SNAPSHOTS[model] ?? model;
}

export function normalizeImageModel(value: unknown): string {
  const model = typeof value === 'string' && value.trim() ? value.trim() : DEFAULT_OPENAI_IMAGE_MODEL;
  if (LEGACY_MODELS.has(model)) return DEFAULT_OPENAI_IMAGE_MODEL;
  if (!isOpenAIImageModel(model) && !(model in SNAPSHOTS)) {
    throw new Error('Неподдерживаемый режим GPT Image 2.5');
  }
  return model;
}

export function imageModelCapabilities(model: string): { qualities: string[]; backgrounds: string[] } {
  const family = imageModelFamily(normalizeImageModel(model));
  const is25 = family === 'gpt-image-2.5-flare' || family === 'gpt-image-2.5-sunburst';
  return {
    qualities: is25 ? ['low', 'medium', 'high', 'xhigh', 'max', 'auto'] : ['low', 'medium', 'high', 'auto'],
    backgrounds: is25 ? ['opaque', 'auto', 'transparent'] : ['opaque', 'auto'],
  };
}

export function validateImageSize(size: string): void {
  if (size === 'auto') return;
  const parts = size.split('x');
  if (parts.length !== 2) throw new Error('Размер нужен в виде ШИРИНАxВЫСОТА');
  const width = Number(parts[0]);
  const height = Number(parts[1]);
  if (!Number.isInteger(width) || !Number.isInteger(height)) throw new Error('Размер нужен в виде ШИРИНАxВЫСОТА');
  const short = Math.min(width, height);
  const long = Math.max(width, height);
  const pixels = width * height;
  if (width % 16 || height % 16) throw new Error('Стороны картинки должны делиться на 16');
  if (long > 3840 || long > short * 3) throw new Error('Сторона или пропорции выходят за предел GPT Image 2.5');
  if (pixels < 655_360 || pixels > 8_294_400) throw new Error('Число пикселей выходит за предел GPT Image 2.5');
}

export function normalizeImageOptions(raw: Record<string, unknown> | null | undefined): ImageOptions {
  const source: Record<string, unknown> = { ...DEFAULT_IMAGE_OPTIONS, ...(raw ?? {}) };
  const model = normalizeImageModel(source.model);
  const capabilities = imageModelCapabilities(model);
  const size = String(source.size || DEFAULT_IMAGE_OPTIONS.size).toLowerCase();
  validateImageSize(size);
  const quality = String(source.quality || 'low').toLowerCase();
  if (!capabilities.qualities.includes(quality)) throw new Error(`Качество ${quality} не поддерживается моделью ${model}`);
  const outputFormat = String(source.output_format || 'png').toLowerCase();
  if (outputFormat !== 'png' && outputFormat !== 'jpeg' && outputFormat !== 'webp') {
    throw new Error('Формат картинки: png, jpeg или webp');
  }
  const background = String(source.background || 'auto').toLowerCase();
  if (!capabilities.backgrounds.includes(background)) throw new Error(`Фон ${background} не поддерживается моделью ${model}`);
  if (background === 'transparent' && outputFormat === 'jpeg') throw new Error('Для прозрачного фона выберите PNG или WebP');
  const moderation = String(source.moderation || 'auto').toLowerCase();
  if (moderation !== 'auto' && moderation !== 'low') throw new Error('Модерация: auto или low');
  const result: ImageOptions = { model, size, quality, output_format: outputFormat, background, moderation };
  const compression = source.output_compression;
  if ((outputFormat === 'jpeg' || outputFormat === 'webp') && compression != null) {
    const value = typeof compression === 'number' ? compression : Number(compression);
    if (!Number.isInteger(value) || value < 0 || value > 100) throw new Error('Сжатие — целое число от 0 до 100');
    result.output_compression = value;
  }
  return result;
}

export function publicGeneration(options: ImageOptions) {
  return {
    size: options.size,
    quality: options.quality,
    outputFormat: options.output_format,
    outputCompression: options.output_compression ?? 100,
    background: options.background,
    moderation: options.moderation,
  };
}

export function readGeneration(raw: unknown, model?: string): ImageOptions {
  const saved = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  try {
    return normalizeImageOptions({ ...DEFAULT_IMAGE_OPTIONS, ...saved, model: model ?? saved.model });
  } catch {
    return normalizeImageOptions({ ...DEFAULT_IMAGE_OPTIONS, model });
  }
}

export function splitOpenAIKeys(raw: string | null | undefined): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const part of (raw ?? '').split(/[,\s]+/)) {
    const value = part.trim();
    if (value && !seen.has(value)) {
      seen.add(value);
      result.push(value);
    }
  }
  return result;
}

export function buildOpenAIImageRequest(input: {
  prompt: string;
  options: Record<string, unknown> | ImageOptions;
  referenceImage?: string;
  endUserId?: string;
}): { endpoint: '/v1/images/generations' | '/v1/images/edits'; body: Record<string, unknown> } {
  const body: Record<string, unknown> = {
    prompt: input.prompt,
    n: 1,
    ...normalizeImageOptions({ ...input.options }),
  };
  if (input.endUserId) body.user = input.endUserId;
  if (input.referenceImage) {
    body.images = [{ image_url: input.referenceImage }];
    return { endpoint: '/v1/images/edits', body };
  }
  return { endpoint: '/v1/images/generations', body };
}

export function parseOpenAIImageResponse(payload: unknown, requestId: string | null = null): GeneratedImage {
  const root = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
  const data = root.data;
  const first = Array.isArray(data) ? data[0] : null;
  const encoded = first && typeof first === 'object' ? (first as { b64_json?: unknown }).b64_json : null;
  if (typeof encoded !== 'string' || !encoded) throw new Error('OpenAI не вернул картинку');
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length === 0) throw new Error('OpenAI не вернул картинку');
  let extension = 'png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) extension = 'jpeg';
  else if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') extension = 'webp';
  const usage = root.usage && typeof root.usage === 'object' ? root.usage as Record<string, unknown> : null;
  return {
    bytes,
    mediaType: extension === 'jpeg' ? 'image/jpeg' : `image/${extension}`,
    extension,
    requestId,
    usage,
  };
}

function tokenCount(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.max(0, Math.round(value));
}

/**
 * Себестоимость realtime GPT Image, как в TISMOS: USD за миллион токенов
 * численно равны микродолларам за токен. Картинка на входе 8, текст 5, картинка на выходе 30.
 */
export const DEFAULT_IMAGE_TOKEN_RATES = {
  textUsdPerM: 5_000_000,
  imageInUsdPerM: 8_000_000,
  imageOutUsdPerM: 30_000_000,
};

export function imageCostUsdMicros(
  usage: unknown,
  rates: { textUsdPerM: number; imageInUsdPerM: number; imageOutUsdPerM: number } = DEFAULT_IMAGE_TOKEN_RATES,
): number | null {
  if (!usage || typeof usage !== 'object') return null;
  const row = usage as Record<string, unknown>;
  const input = row.input_tokens_details;
  const output = row.output_tokens_details;
  if (!input || typeof input !== 'object' || !output || typeof output !== 'object') return null;
  const imageInput = tokenCount((input as Record<string, unknown>).image_tokens);
  const textInput = tokenCount((input as Record<string, unknown>).text_tokens);
  const imageOutput = tokenCount((output as Record<string, unknown>).image_tokens);
  if (imageInput == null || textInput == null || imageOutput == null) return null;
  return Math.round(
    (imageInput * rates.imageInUsdPerM + textInput * rates.textUsdPerM + imageOutput * rates.imageOutUsdPerM) / 1_000_000,
  );
}

export function centsFromMicros(micros: number): number {
  if (!Number.isFinite(micros) || micros <= 0) return 0;
  return Math.max(1, Math.ceil(micros / 10_000));
}

export function imageTokenCounts(usage: unknown): { promptTokens: number; completionTokens: number; totalTokens: number } {
  const row = usage && typeof usage === 'object' ? usage as Record<string, unknown> : {};
  const input = tokenCount(row.input_tokens) ?? 0;
  const output = tokenCount(row.output_tokens) ?? 0;
  const total = tokenCount(row.total_tokens) ?? input + output;
  return { promptTokens: input, completionTokens: output, totalTokens: total };
}

function originOf(baseUrl: string): string {
  let origin: URL;
  try {
    origin = new URL(baseUrl);
  } catch {
    throw new Error('Некорректный адрес API');
  }
  if (origin.protocol !== 'https:') throw new Error('Адрес API должен начинаться с https://');
  return origin.origin;
}

function openAIError(status: number, body: string): string {
  const clean = body.replace(/\s+/g, ' ').slice(0, 240);
  return `OpenAI ответил ${status}${clean ? `: ${clean}` : ''}`;
}

export async function generateImageViaOpenAI(input: {
  apiKeys: string[];
  prompt: string;
  options: Record<string, unknown> | ImageOptions;
  referenceImage?: string;
  endUserId?: string;
  baseUrl: string;
  fetchImpl?: typeof fetch;
}): Promise<GeneratedImage> {
  const keys = input.apiKeys.filter(Boolean);
  if (keys.length === 0) throw new Error('Ключ OpenAI ещё не задан');
  const built = buildOpenAIImageRequest({
    prompt: input.prompt,
    options: input.options,
    referenceImage: input.referenceImage,
    endUserId: input.endUserId,
  });
  const url = `${originOf(input.baseUrl)}${built.endpoint}`;
  const fetchImpl = input.fetchImpl ?? fetch;
  let lastError = 'OpenAI: нет доступных ключей';
  for (const key of keys) {
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(built.body),
        signal: AbortSignal.timeout(240_000),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'сеть недоступна';
      throw new Error(`OpenAI не ответил: ${message}`);
    }
    if (response.ok) {
      return parseOpenAIImageResponse(await response.json(), response.headers.get('x-request-id'));
    }
    const text = await response.text();
    lastError = openAIError(response.status, text);
    const retry = response.status === 401 || response.status === 403 || response.status === 429 || response.status >= 500;
    if (!retry) throw new Error(lastError);
  }
  throw new Error(lastError);
}

export async function probeOpenAIImageKey(input: {
  apiKey: string;
  model: string;
  baseUrl: string;
  fetchImpl?: typeof fetch;
}): Promise<{ ok: true; model: string } | { ok: false; model: string; error: string }> {
  const model = normalizeImageModel(input.model);
  const fetchImpl = input.fetchImpl ?? fetch;
  const url = `${originOf(input.baseUrl)}/v1/models/${encodeURIComponent(model)}`;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${input.apiKey}` },
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'сеть недоступна';
    return { ok: false, model, error: `OpenAI не ответил: ${message}` };
  }
  if (!response.ok) {
    return { ok: false, model, error: openAIError(response.status, await response.text()) };
  }
  const payload = await response.json() as { id?: unknown };
  return { ok: true, model: typeof payload.id === 'string' && payload.id ? payload.id : model };
}
