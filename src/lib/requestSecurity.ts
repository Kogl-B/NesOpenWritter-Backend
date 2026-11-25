const readMethods = new Set(['GET', 'HEAD', 'OPTIONS']);

export function isReadMethod(method: string): boolean {
  return readMethods.has(method);
}

type SecurityHeaders = Record<string, string | string[] | undefined>;

export function isBrowserMutationAllowed(
  method: string, headers: SecurityHeaders, trustedOrigins: ReadonlySet<string>,
): boolean {
  if (isReadMethod(method)) return true;
  const origin = headers.origin;
  if (origin !== undefined) return typeof origin === 'string' && trustedOrigins.has(origin);
  // Service clients without browser authentication are checked by the endpoint itself.
  return !headers.cookie && !headers['sec-fetch-site'];
}
