import assert from 'node:assert/strict';
import test from 'node:test';
import sharp from 'sharp';
import { portraitStorageUrl, thumbnailForPortrait } from './portraitThumb.js';

test('legacy raster portraits yield a shared, small WebP preview', async () => {
  const original = await sharp({
    create: { width: 1200, height: 850, channels: 3, background: '#423852' },
  }).png().toBuffer();
  const href = `data:image/png;base64,${original.toString('base64')}`;
  const [first, second] = await Promise.all([thumbnailForPortrait(href), thumbnailForPortrait(href)]);
  assert.ok(first);
  assert.equal(first, second);
  assert.equal(await thumbnailForPortrait(href), first);
  const info = await sharp(first).metadata();
  assert.deepEqual([info.format, info.width, info.height], ['webp', 160, 160]);
  assert.ok(first.length < original.length);
});

test('preview source stays inside public storage and raster formats', async () => {
  const storage = 'https://files.example.test/media/';
  const key = 'users/one/projects/two/portrait/photo.jpg';
  assert.equal(portraitStorageUrl(key, storage), storage + key);
  assert.equal(portraitStorageUrl(storage + key, storage), storage + key);
  for (const source of [
    'https://other.example.test/' + key,
    'http://files.example.test/media/' + key,
    'https://files.example.test/' + key,
    'https://files.example.test/media/users/%2fprivate/file.jpg',
    'https://files.example.test/media/' + key + '?redirect=1',
    'https://files.example.test/media/reports/file.jpg',
  ]) assert.equal(portraitStorageUrl(source, storage), null);
  assert.equal(await thumbnailForPortrait('data:image/svg+xml;base64,PHN2Zy8+'), null);
  assert.equal(await thumbnailForPortrait('data:image/png;base64,AAAA'), null);
});
