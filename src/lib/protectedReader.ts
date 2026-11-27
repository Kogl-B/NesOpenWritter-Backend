import { createCanvas, GlobalFonts } from '@napi-rs/canvas';
import { fileURLToPath } from 'node:url';

import { chapterBlocks } from './publish/text.js';
import { projectFootnotes, footnoteLines } from './footnoteText.js';
import { mapDirectoryReferences } from './worldDirectory.js';

export const PAGE_WIDTH = 880;
const GUTTER = 42;
const FONT = '32px "OpenWritter Reader"';
const LINE_HEIGHT = 49;
const LINES_PER_PAGE = 20;
const INK = '#211d17';
const PAPER = '#fbf8ed';
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const cache = new Map<string, ReaderPage[]>();

export interface ReaderDirectorySpot {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

type ReaderPage = { kind: 'text'; lines: string[]; references: ReaderDirectorySpot[] } | { kind: 'image'; src: string };
let fontLoaded = false;

function useFont() {
  if (fontLoaded) return;
  const location = new URL('../../assets/reader-font/LiberationSerif-Regular.ttf', import.meta.url);
  if (!GlobalFonts.registerFromPath(fileURLToPath(location), 'OpenWritter Reader')) throw new Error('Protected reader font unavailable');
  fontLoaded = true;
}

function imageSource(node: unknown): string | null {
  if (!node || typeof node !== 'object') return null;
  const image = node as { type?: unknown; attrs?: { src?: unknown } };
  const src = image.attrs?.src;
  if (image.type !== 'image' || typeof src !== 'string') return null;
  if (/^data:image\/(?:png|jpe?g|webp|gif);base64,[a-z0-9+/=]+$/i.test(src)) return src;
  if (/^\/(?:api\/(?:files|uploads)\/|uploads\/)[^\s]+$/.test(src) && !src.includes('\\')) return src;
  try {
    const url = new URL(src);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

export function cachedReaderPages(key: string): ReaderPage[] | undefined {
  const pages = cache.get(key);
  if (pages) {
    cache.delete(key);
    cache.set(key, pages);
  }
  return pages;
}

export function readerPages(key: string, content: unknown): ReaderPage[] {
  const cached = cachedReaderPages(key);
  if (cached) return cached;
  useFont();
  const context = createCanvas(1, 1).getContext('2d');
  context.font = FONT;
  const fits = (text: string) => context.measureText(text).width <= PAGE_WIDTH - 2 * GUTTER;
  const pages: ReaderPage[] = [];
  const referenceIds: string[] = [];
  let lines: string[] = [];
  let references: ReaderDirectorySpot[] = [];
  function flush() {
    while (lines.at(-1) === '') lines.pop();
    if (lines.length) pages.push({ kind: 'text', lines, references });
    lines = [];
    references = [];
  }
  function line(value: string, spots: Array<Omit<ReaderDirectorySpot, 'y'>> = []) {
    if (lines.length === LINES_PER_PAGE) flush();
    references.push(...spots.map((spot) => ({ ...spot, y: GUTTER + lines.length * LINE_HEIGHT })));
    if (value || lines.length) lines.push(value);
  }
  function paragraph(text: string) {
    let current = '';
    let spots: Array<Omit<ReaderDirectorySpot, 'y'>> = [];
    const commit = () => {
      if (current) line(current, spots);
      current = '';
      spots = [];
    };
    for (const token of text.match(/\S+/gu) ?? []) {
      const key = /^\uE100(\d+)\uE101$/.exec(token);
      const id = key ? referenceIds[Number(key[1])] : undefined;
      const word = id ? '[Справка]' : token;
      const combined = current ? `${current} ${word}` : word;
      if (!fits(combined)) commit();
      if (id) {
        const prefix = current ? current + ' ' : '';
        spots.push({
          id, x: GUTTER + context.measureText(prefix).width, width: context.measureText(word).width, height: LINE_HEIGHT - 3,
        });
        current = prefix + word;
      } else if (fits(word)) {
        current = current ? `${current} ${word}` : word;
      } else {
        for (const { segment } of graphemes.segment(word)) {
          if (current && !fits(current + segment)) commit();
          current += segment;
        }
      }
    }
    commit();
  }
  const notes: string[] = [];
  const projected = mapDirectoryReferences(projectFootnotes(content, notes), (reference) => ({
    type: 'text', text: ` \uE100${referenceIds.push(reference.id) - 1}\uE101 `,
  }));
  const nodes = projected && typeof projected === 'object' ? (projected as { content?: unknown[] }).content : undefined;
  if (Array.isArray(nodes)) {
    for (const node of nodes) {
      const image = imageSource(node);
      if (image) {
        flush();
        pages.push({ kind: 'image', src: image });
        continue;
      }
      for (const text of chapterBlocks({ content: [node] })) {
        text.split('\n').forEach(paragraph);
        line('');
      }
    }
  } else if (typeof content === 'string') {
    content.replace(/[\uE100\uE101]/g, '').split(/\r?\n/).forEach((text) => { paragraph(text); line(''); });
  }
  for (const note of footnoteLines(notes)) {
    note.replace(/[\uE100\uE101]/g, '').split('\n').forEach(paragraph);
    line('');
  }
  flush();
  while (cache.size >= 12) cache.delete(cache.keys().next().value!);
  cache.set(key, pages);
  return pages;
}

export function pageHeight(lines: number) {
  return 2 * GUTTER + LINE_HEIGHT * lines;
}

export async function renderReaderPage(lines: string[], references: ReaderDirectorySpot[] = []) {
  useFont();
  const canvas = createCanvas(PAGE_WIDTH, pageHeight(lines.length));
  const context = canvas.getContext('2d');
  context.fillStyle = PAPER;
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.font = FONT;
  context.fillStyle = INK;
  context.textBaseline = 'top';
  lines.forEach((text, index) => context.fillText(text, GUTTER, GUTTER + index * LINE_HEIGHT));
  context.fillStyle = '#875521';
  for (const reference of references) context.fillRect(reference.x, reference.y + 37, reference.width, 2);
  return canvas.encode('png');
}
