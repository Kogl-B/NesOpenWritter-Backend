import { createHash } from 'node:crypto';
import sharp from 'sharp';

const size = 160;
const maxOriginalBytes = 20 * 1024 * 1024;
const maxInlineLength = 500_000;
const maxCached = 256;
const maxPending = 96;
const maxConcurrent = 4;
const cache = new Map<string, { image: Buffer | null; until: number }>();
const pending = new Map<string, Promise<Buffer | null>>();
const queue: Array<() => void> = [];
let active = 0;

export function portraitStorageUrl(source: string, storageBase?: string) {
  if (!storageBase) return null;
  try {
    const base = new URL(storageBase);
    const folder = base.pathname.replace(/\/$/, '') + '/';
    if (base.protocol !== 'https:') return null;
    const url = new URL(source, base.origin + folder);
    if (url.origin !== base.origin || url.username || url.password || url.search || url.hash ||
      !url.pathname.startsWith(folder + 'users/')) return null;
    const key = url.pathname.slice(folder.length);
    if (!/^users\/[\w-]+\/(?:[\w.-]+\/)*[\w.-]+$/.test(key)) return null;
    return url.href;
  } catch {
    return null;
  }
}

async function readOriginal(url: string): Promise<Buffer | null> {
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(7_000) });
  const length = Number(response.headers.get('content-length'));
  if (!response.ok || !response.body || length > maxOriginalBytes) {
    await response.body?.cancel();
    return null;
  }
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxOriginalBytes) {
      await reader.cancel();
      return null;
    }
    parts.push(value);
  }
  return Buffer.concat(parts, received);
}

export async function thumbnailForPortrait(source: string, storageBase?: string): Promise<Buffer | null> {
  const encoded = source.length <= maxInlineLength
    ? /^data:image\/(?:png|jpeg|webp|gif|avif);base64,([A-Za-z0-9+/]+=*)$/i.exec(source)?.[1]
    : undefined;
  const url = encoded ? null : portraitStorageUrl(source, storageBase);
  if (!encoded && !url) return null;

  const key = url ?? createHash('sha256').update(encoded!).digest('hex');
  const saved = cache.get(key);
  if (saved) {
    cache.delete(key);
    if (saved.until > Date.now()) {
      cache.set(key, saved);
      return saved.image;
    }
  }
  const running = pending.get(key);
  if (running) return running;
  if (pending.size >= maxPending) return null;

  const work = new Promise<Buffer | null>(resolve => {
    queue.push(() => {
      active += 1;
      void (async () => {
        let image: Buffer | null = null;
        try {
          const bytes = url ? await readOriginal(url) : Buffer.from(encoded!, 'base64');
          if (bytes) {
            const raster = sharp(bytes, { limitInputPixels: 25_000_000 });
            const { format } = await raster.metadata();
            if (format && ['png', 'jpeg', 'webp', 'gif', 'heif'].includes(format)) {
              image = await raster.rotate().resize(size, size, { fit: 'cover', withoutEnlargement: true })
                .webp({ quality: 75 }).toBuffer();
            }
          }
        } catch {
          // A missing or unreadable original is represented by initials.
        } finally {
          cache.set(key, { image, until: Date.now() + (image ? 3_600_000 : 30_000) });
          while (cache.size > maxCached) cache.delete(cache.keys().next().value!);
          pending.delete(key);
          resolve(image);
          active -= 1;
          queue.shift()?.();
        }
      })();
    });
  });
  pending.set(key, work);
  if (active < maxConcurrent) queue.shift()?.();
  return work;
}
