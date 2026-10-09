import type { Prisma } from '@prisma/client';
import { prisma } from './prisma.js';

/**
 * Единый TTL-кэш доступа к проекту (R22): роль owner/admin/editor/viewer
 * или null. Раньше RBAC-preHandler и assertProjectOwnership держали ДВА
 * независимых кэша и на промахе делали одинаковые запросы (project +
 * collaborator) дважды на мутирующих запросах. Теперь один источник:
 * наличие доступа ⇔ роль не null.
 */
export type ProjectRole = 'owner' | 'admin' | 'editor' | 'viewer';

const roleCache = new Map<string, { role: ProjectRole | null; expires: number }>();
const CACHE_TTL_MS = 30_000; // 30 секунд

export async function getProjectAccess(projectId: string, userId: string): Promise<ProjectRole | null> {
  const key = `${projectId}:${userId}`;
  const hit = roleCache.get(key);
  if (hit && Date.now() < hit.expires) return hit.role;
  const [own, collab] = await Promise.all([
    prisma.project.findFirst({
      where: { id: projectId, ownerId: userId },
      select: { id: true },
    }),
    prisma.projectCollaborator.findFirst({
      where: { projectId, userId, status: 'active' },
      select: { role: true },
    }),
  ]);
  const role: ProjectRole | null = own ? 'owner' : (collab?.role as ProjectRole | undefined) ?? null;
  if (roleCache.size > 500) roleCache.clear(); // prevent leak
  roleCache.set(key, { role, expires: Date.now() + CACHE_TTL_MS });
  return role;
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
