import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { withMarkup } from './deepseek.js';
import {
  buildOpenAIImageRequest,
  readGeneration,
  aiBalanceRefusal,
  centsFromMicros,
  generateImageViaOpenAI,
  imageCostUsdMicros,
  normalizeImageModel,
  normalizeImageOptions,
  parseOpenAIImageResponse,
  splitOpenAIKeys,
  validateImageSize,
} from './openaiImage.js';

describe('GPT Image 2.5', () => {
  it('пускает услугу ИИ от 0.50 $ и останавливает меньший баланс', () => {
    assert.equal(aiBalanceRefusal(50), null);
    assert.equal(aiBalanceRefusal(51), null);
    assert.match(aiBalanceRefusal(49) ?? '', /0\.50/);
    assert.match(aiBalanceRefusal(0) ?? '', /0\.50/);
  });

  it('принимает минимальный квадрат и отвергает кривой размер', () => {
    validateImageSize('816x816');
    for (const value of ['800x800', '817x816', '1024x400', '3840x3856']) {
      assert.throws(() => validateImageSize(value), /предел|делиться|ШИРИНА/);
    }
  });

  it('собирает то же тело запроса, что модуль TISMOS', () => {
    const options = normalizeImageOptions({
      size: '816x816',
      quality: 'low',
      output_format: 'jpeg',
      output_compression: 70,
    });
    const generated = buildOpenAIImageRequest({
      prompt: 'Сгенерируй замок',
      options: { ...options },
      endUserId: 'user-1',
    });
    assert.equal(generated.endpoint, '/v1/images/generations');
    assert.deepEqual(generated.body, {
      model: 'gpt-image-2.5-flare',
      prompt: 'Сгенерируй замок',
      n: 1,
      size: '816x816',
      quality: 'low',
      output_format: 'jpeg',
      background: 'auto',
      moderation: 'auto',
      output_compression: 70,
      user: 'user-1',
    });

    const edited = buildOpenAIImageRequest({
      prompt: 'Измени замок',
      options: { ...options },
      referenceImage: 'data:image/png;base64,YQ==',
    });
    assert.equal(edited.endpoint, '/v1/images/edits');
    assert.deepEqual(edited.body.images, [{ image_url: 'data:image/png;base64,YQ==' }]);
  });

  it('читает сохранённые настройки генерации и откатывается к низкому квадрату', () => {
    const saved = readGeneration({ size: '768x1024', quality: 'high', output_format: 'webp', background: 'transparent' }, 'gpt-image-2.5-sunburst');
    assert.equal(saved.size, '768x1024');
    assert.equal(saved.quality, 'high');
    assert.equal(saved.model, 'gpt-image-2.5-sunburst');
    const fallback = readGeneration({ size: '10x10' });
    assert.equal(fallback.size, '1024x1024');
    assert.equal(fallback.quality, 'low');
  });

  it('держит два режима Image 2.5 и переводит старую модель на Flare', () => {
    assert.equal(normalizeImageModel('gpt-image-2'), 'gpt-image-2.5-flare');
    assert.equal(normalizeImageModel('gpt-image-2.5-sunburst'), 'gpt-image-2.5-sunburst');
    const transparent = normalizeImageOptions({ model: 'gpt-image-2.5-sunburst', output_format: 'webp', background: 'transparent' });
    assert.equal(transparent.model, 'gpt-image-2.5-sunburst');
    assert.equal(transparent.background, 'transparent');
    assert.throws(() => normalizeImageModel('dall-e-3'));
  });

  it('узнаёт JPEG по байтам и считает себестоимость по токенам', () => {
    const image = Buffer.from([0xff, 0xd8, 0xff, 1, 2, 3]);
    const parsed = parseOpenAIImageResponse({
      data: [{ b64_json: image.toString('base64') }],
      usage: {
        input_tokens: 12,
        output_tokens: 40,
        input_tokens_details: { image_tokens: 2, text_tokens: 10 },
        output_tokens_details: { image_tokens: 40 },
      },
    }, 'req-test');
    assert.equal(parsed.extension, 'jpeg');
    assert.equal(parsed.mediaType, 'image/jpeg');
    assert.equal(parsed.requestId, 'req-test');
    const real = 2 * 8 + 10 * 5 + 40 * 30;
    assert.equal(imageCostUsdMicros(parsed.usage), real);
    assert.equal(withMarkup(real, 3), real * 3);
    assert.equal(withMarkup(real, 0), real * 3);
    assert.equal(centsFromMicros(1_216), 1);
    assert.equal(imageCostUsdMicros({}), null);
  });

  it('берёт следующий ключ после отказа и не повторяет ошибку запроса', async () => {
    assert.deepEqual(splitOpenAIKeys(' sk-a,\nsk-a sk-b '), ['sk-a', 'sk-b']);
    const seen: string[] = [];
    const ok = await generateImageViaOpenAI({
      apiKeys: ['sk-bad', 'sk-good'],
      prompt: 'замок',
      options: { size: '816x816' },
      baseUrl: 'https://api.openai.com',
      fetchImpl: async (_url, init) => {
        const auth = new Headers(init?.headers).get('authorization') ?? '';
        seen.push(auth);
        if (auth.endsWith('sk-bad')) return new Response('no', { status: 401 });
        const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
        return new Response(JSON.stringify({ data: [{ b64_json: bytes.toString('base64') }] }), {
          status: 200,
          headers: { 'x-request-id': 'req-2' },
        });
      },
    });
    assert.deepEqual(seen, ['Bearer sk-bad', 'Bearer sk-good']);
    assert.equal(ok.extension, 'png');
    assert.equal(ok.requestId, 'req-2');

    await assert.rejects(
      () => generateImageViaOpenAI({
        apiKeys: ['sk-bad'],
        prompt: 'замок',
        options: { size: '816x816' },
        baseUrl: 'https://api.openai.com',
        fetchImpl: async () => new Response('bad prompt', { status: 400 }),
      }),
      /OpenAI ответил 400/,
    );
  });
});
