import type { Prisma } from '@prisma/client';
import { prisma } from './prisma.js';

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
  const project = await prisma.project.findFirst({
    where: { id: projectId, ownerId: userId },
    select: { id: true },
  });
  return project !== null;
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
