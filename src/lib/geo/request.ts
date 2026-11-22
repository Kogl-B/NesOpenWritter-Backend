import type { FastifyReply, FastifyRequest } from 'fastify';

import { env } from '../env.js';
import { prisma } from '../prisma.js';
import { countryOfIp } from './lookup.js';
import {
  GEO_DENIED,
  blogPostId,
  bookBlocked,
  catalogBookTarget,
  chapterBlocked,
  indexBlocks,
  postBlocked,
  publicIp,
  trustedCountry,
  type GeoIndex,
} from './policy.js';
import { knownCountry } from './countries.js';

const TTL_MS = 5_000;

const EMPTY_INDEX: GeoIndex = { books: new Map(), chapters: new Map(), posts: new Map() };

let cached: { at: number; index: GeoIndex } | null = null;

export function clearGeoCache(): void {
  cached = null;
}

function headerValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? '';
  return value ?? '';
}

export function visitorCountry(req: FastifyRequest): string | null {
  if (env.NODE_ENV !== 'production') {
    const dev = knownCountry(env.GEO_DEV_COUNTRY);
    if (dev) return dev;
  }
  const fromEdge = trustedCountry(
    headerValue(req.headers['x-ow-country']),
    headerValue(req.headers['x-ow-geo-token']),
    env.GEO_EDGE_TOKEN,
  );
  if (fromEdge) return fromEdge;
  return countryOfIp(publicIp(headerValue(req.headers['x-forwarded-for'])));
}

export async function loadGeoIndex(): Promise<GeoIndex> {
  const now = Date.now();
  if (cached && now - cached.at < TTL_MS) return cached.index;
  const rows = await prisma.geoBlock.findMany({
    select: { kind: true, targetId: true, countries: true },
  });
  const index = indexBlocks(rows);
  cached = { at: now, index };
  return index;
}

export async function countryBlocks(req: FastifyRequest): Promise<{ country: string | null; index: GeoIndex }> {
  const country = visitorCountry(req);
  if (!country) return { country: null, index: EMPTY_INDEX };
  return { country, index: await loadGeoIndex() };
}

export function denyGeo(reply: FastifyReply) {
  return reply.status(451).send(GEO_DENIED);
}

export async function denyCatalogGeo(req: FastifyRequest, reply: FastifyReply): Promise<boolean> {
  const target = catalogBookTarget(req.url);
  if (!target) return false;
  const geo = await countryBlocks(req);
  if (!geo.country) return false;
  const project = await prisma.project.findUnique({
    where: { id: target.bookId },
    select: { settings: true },
  });
  const settings = project?.settings;
  const catalog = settings && typeof settings === 'object'
    ? (settings as { catalog?: { published?: unknown } }).catalog
    : undefined;
  if (catalog?.published !== true) return false;
  if (bookBlocked(geo.index, geo.country, target.bookId)) {
    await denyGeo(reply);
    return true;
  }
  if (!target.chapterId || !chapterBlocked(geo.index, geo.country, target.bookId, target.chapterId)) return false;
  const chapter = await prisma.chapter.findFirst({
    where: { id: target.chapterId, projectId: target.bookId },
    select: { metadata: true },
  });
  const metadata = chapter?.metadata;
  const hidden = Boolean(
    metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    && (metadata as { public?: unknown }).public === false,
  );
  if (!chapter || hidden) return false;
  await denyGeo(reply);
  return true;
}

export async function denyBlogGeo(req: FastifyRequest, reply: FastifyReply): Promise<boolean> {
  const postId = blogPostId(req.url);
  if (!postId) return false;
  const geo = await countryBlocks(req);
  if (!geo.country || !postBlocked(geo.index, geo.country, postId)) return false;
  const post = await prisma.blogPost.findFirst({
    where: { id: postId, published: true },
    select: { id: true },
  });
  if (!post) return false;
  await denyGeo(reply);
  return true;
}
