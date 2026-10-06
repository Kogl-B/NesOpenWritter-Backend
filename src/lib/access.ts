import type { Prisma } from '@prisma/client';
import { prisma } from './prisma.js';

// TTL-кэш для ownership проверок (снижает DB roundtrip на каждый request)
const ownershipCache = new Map<string, { value: boolean; expires: number }>();
const CACHE_TTL_MS = 30_000; // 30 секунд

function getCachedOwnership(projectId: string, userId: string): boolean | undefined {
  const key = `${projectId}:${userId}`;
  const entry = ownershipCache.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expires) {
    ownershipCache.delete(key);
    return undefined;
  }
  return entry.value;
}

function setCachedOwnership(projectId: string, userId: string, value: boolean): void {
  const key = `${projectId}:${userId}`;
  if (ownershipCache.size > 500) ownershipCache.clear(); // prevent leak
  ownershipCache.set(key, { value, expires: Date.now() + CACHE_TTL_MS });
}

export type JsonValue = Prisma.InputJsonValue;

export const toJson = (v: Record<string, unknown> | undefined): JsonValue =>
  (v ?? {}) as JsonValue;

/**
 * Verify that `projectId` belongs to `userId`. Returns true if owned.
 * Used as a 404 boundary for all sub-resources.
 */
export async function assertProjectOwnership(
  projectId: string,
  userId: string,
): Promise<boolean> {
  const cached = getCachedOwnership(projectId, userId);
  if (cached !== undefined) return cached;

  const project = await prisma.project.findFirst({
    where: { id: projectId, ownerId: userId },
    select: { id: true },
  });
  const result = project !== null;
  setCachedOwnership(projectId, userId, result);
  return result;
}

/**
 * Verify that a character belongs to a project (already owned by user).
 * Caller must have run assertProjectOwnership first.
 */
export async function assertCharacterInProject(
  characterId: string,
  projectId: string,
): Promise<boolean> {
  const c = await prisma.character.findFirst({
    where: { id: characterId, projectId },
    select: { id: true },
  });
  return c !== null;
}
