import { timingSafeEqual } from 'node:crypto';

import { knownCountry } from './countries.js';

export const GEO_DENIED = {
  error: 'GeoRestricted',
  message: 'Материал недоступен в вашем регионе',
} as const;

export interface GeoRow {
  kind: string;
  targetId: string;
  countries: string[];
}

export interface GeoIndex {
  books: Map<string, Set<string>>;
  chapters: Map<string, Set<string>>;
  posts: Map<string, Set<string>>;
}

export function tokenMatches(given: string, expected: string): boolean {
  if (!expected || !given) return false;
  const left = Buffer.from(given);
  const right = Buffer.from(expected);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** Страна из прокси, только если секрет совпал. Без секрета заголовок не смотрим. */
export function trustedCountry(countryHeader: string, tokenHeader: string, expectedToken: string): string | null {
  if (!tokenMatches(tokenHeader, expectedToken)) return null;
  return knownCountry(countryHeader);
}

export function countryList(values: string[]): { ok: string[] } | { error: string } {
  if (values.length === 0) return { error: 'Укажите страну' };
  if (values.length > 30) return { error: 'Слишком много стран' };
  const seen: string[] = [];
  for (const value of values) {
    const code = knownCountry(value);
    if (!code) return { error: 'Неизвестная страна' };
    if (!seen.includes(code)) seen.push(code);
  }
  return { ok: seen };
}

function v4Parts(ip: string): [number, number, number, number] | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  const nums: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    nums.push(n);
  }
  return [nums[0]!, nums[1]!, nums[2]!, nums[3]!];
}

export function normalizeIp(raw: string): string | null {
  let value = raw.trim().replace(/^"|"$/g, '');
  if (!value || value.toLowerCase() === 'unknown') return null;
  if (value.startsWith('[')) {
    const end = value.indexOf(']');
    if (end < 0) return null;
    value = value.slice(1, end);
  } else if (/^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(value)) {
    value = value.slice(0, value.lastIndexOf(':'));
  }
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(value);
  if (mapped?.[1]) value = mapped[1];
  const v4 = v4Parts(value);
  if (v4) return v4.join('.');
  if (value.includes(':') && /^[0-9a-f:]+$/i.test(value)) return value.toLowerCase();
  return null;
}

export function isPrivateIp(ip: string): boolean {
  const v4 = v4Parts(ip);
  if (v4) {
    const a = v4[0];
    const b = v4[1];
    const c = v4[2];
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 192 && b === 0 && c === 2) return true;
    if (a === 198 && (b === 18 || b === 19)) return true;
    if (a === 198 && b === 51 && c === 100) return true;
    if (a === 203 && b === 0 && c === 113) return true;
    if (a >= 224) return true;
    return false;
  }
  const v6 = ip.toLowerCase();
  if (v6 === '::' || v6 === '::1') return true;
  if (v6.startsWith('fc') || v6.startsWith('fd')) return true;
  if (/^fe[89ab]/.test(v6)) return true;
  return false;
}

/** Правый публичный адрес в X-Forwarded-For: его дописал прокси, левый клиент может подставить сам. */
export function publicIp(forwardedFor: string | undefined): string | null {
  const parts = (forwardedFor ?? '').split(',');
  for (let i = parts.length - 1; i >= 0; i--) {
    const ip = normalizeIp(parts[i] ?? '');
    if (ip && !isPrivateIp(ip)) return ip;
  }
  return null;
}

export function indexBlocks(rows: GeoRow[]): GeoIndex {
  const index: GeoIndex = { books: new Map(), chapters: new Map(), posts: new Map() };
  for (const row of rows) {
    const bag = row.kind === 'book' ? index.books : row.kind === 'chapter' ? index.chapters : row.kind === 'post' ? index.posts : null;
    if (!bag || !row.targetId) continue;
    const countries = new Set<string>();
    for (const item of row.countries) {
      const code = knownCountry(item);
      if (code) countries.add(code);
    }
    if (countries.size > 0) bag.set(row.targetId, countries);
  }
  return index;
}

export function bookBlocked(index: GeoIndex, country: string | null, bookId: string): boolean {
  if (!country) return false;
  return index.books.get(bookId)?.has(country) ?? false;
}

export function chapterBlocked(index: GeoIndex, country: string | null, bookId: string, chapterId: string): boolean {
  if (!country) return false;
  if (bookBlocked(index, country, bookId)) return true;
  return index.chapters.get(chapterId)?.has(country) ?? false;
}

export function postBlocked(index: GeoIndex, country: string | null, postId: string): boolean {
  if (!country) return false;
  return index.posts.get(postId)?.has(country) ?? false;
}

function decodePart(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

export function catalogBookTarget(path: string): { bookId: string; chapterId: string | null } | null {
  const clean = path.split('?')[0] ?? '';
  const match = /^\/api\/catalog\/books\/([^/]+)(?:\/chapters\/([^/]+))?/.exec(clean);
  if (!match?.[1]) return null;
  const bookId = decodePart(match[1]);
  if (!bookId) return null;
  const chapterId = match[2] ? decodePart(match[2]) : null;
  if (match[2] && !chapterId) return null;
  return { bookId, chapterId };
}

export function blogPostId(path: string): string | null {
  const clean = path.split('?')[0] ?? '';
  const match = /^\/api\/blog\/([^/]+)/.exec(clean);
  if (!match?.[1] || match[1] === 'authors') return null;
  return decodePart(match[1]);
}
