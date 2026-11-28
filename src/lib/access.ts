import type { Prisma } from '@prisma/client';
import { prisma } from './prisma.js';

export type ProjectRole = 'owner' | 'admin' | 'editor' | 'viewer';

export async function getProjectAccess(projectId: string, userId: string): Promise<ProjectRole | null> {
  const members = { where: { userId, status: 'active' }, select: { role: true }, take: 1 };
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      ownerId: true,
      ProjectCollaborator: members,
      universe: { select: { ownerId: true, ProjectCollaborator: members } },
    },
  });
  const scope = project?.universe ?? project;
  if (!scope) return null;
  if (scope.ownerId === userId) return 'owner';
  const role = scope.ProjectCollaborator[0]?.role;
  return role === 'admin' || role === 'editor' || role === 'viewer' ? role : null;
}

export type JsonValue = Prisma.InputJsonValue;

export const toJson = (v: Record<string, unknown> | undefined): JsonValue =>
  (v ?? {}) as JsonValue;

/**
 * Verify that `userId` can access `projectId`: the owner OR an active
 * collaborator (invited via the Collaborators panel). Used as a 404
 * boundary for all sub-resources — this is what gives invited readers
 * access to a shared project.
 */
export async function assertProjectOwnership(
  projectId: string,
  userId: string,
): Promise<boolean> {
  return (await getProjectAccess(projectId, userId)) !== null;
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
