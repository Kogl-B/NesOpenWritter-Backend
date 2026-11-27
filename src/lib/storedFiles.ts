const KINDS = new Set(['portrait', 'item', 'map', 'other']);

/** Ключ принадлежит кабинету этого аккаунта: users/{id}/projects/{project}/{kind}/... */
export function parseStoredKey(key: string, userId: string): { projectId: string; kind: string } | null {
  const prefix = `users/${userId}/projects/`;
  if (!key.startsWith(prefix) || key.includes('..') || key.includes('\\')) return null;
  const rest = key.slice(prefix.length);
  const slash = rest.indexOf('/');
  const next = slash >= 0 ? rest.indexOf('/', slash + 1) : -1;
  if (slash <= 0 || next <= slash + 1) return null;
  const projectId = rest.slice(0, slash);
  const rawKind = rest.slice(slash + 1, next);
  if (!projectId || projectId.includes('/')) return null;
  return { projectId, kind: KINDS.has(rawKind) ? rawKind : 'other' };
}
