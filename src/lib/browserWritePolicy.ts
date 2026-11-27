const writes = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const paymentWebhook = '/api/payments/nowpayments/webhook';

export function writeNeedsBrowserOrigin(method: string, url: string): boolean {
  const path = url.split('?', 1)[0] ?? '';
  return writes.has(method) && path.startsWith('/api/') && path !== paymentWebhook;
}

export function browserSource(headers: {
  origin?: string | string[];
  referer?: string | string[];
}): string | null {
  if (headers.origin !== undefined) {
    if (typeof headers.origin !== 'string') return null;
    try {
      const url = new URL(headers.origin);
      return url.origin === headers.origin && ['https:', 'http:'].includes(url.protocol) ? url.origin : null;
    } catch { return null; }
  }
  if (typeof headers.referer !== 'string') return null;
  try {
    const url = new URL(headers.referer);
    return ['https:', 'http:'].includes(url.protocol) ? url.origin : null;
  } catch { return null; }
}
