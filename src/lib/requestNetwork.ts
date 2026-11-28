import { isIP } from 'node:net';
import { URL } from 'node:url';
import type { FastifyRequest } from 'fastify';

import { env } from './env.js';
import { knownCountry } from './geo/countries.js';
import { normalizeIp, tokenMatches } from './geo/policy.js';

export const VERIFIED_IP_HEADER = 'x-ow-verified-client-ip';

type Header = string | string[] | undefined;

function singleIp(value: Header): string | null {
  if (typeof value !== 'string' || value.includes(',')) return null;
  const ip = normalizeIp(value);
  const version = ip ? isIP(ip) : 0;
  if (version === 4) return ip;
  if (version === 6) {
    const canonical = new URL('http://[' + ip + ']').hostname.slice(1, -1);
    // Приводим IPv4-mapped IPv6 к тому же ключу, что и обычный IPv4.
    const mapped = /^::ffff:([a-f0-9]{1,4}):([a-f0-9]{1,4})$/.exec(canonical);
    if (!mapped) return canonical;
    const high = Number.parseInt(mapped[1]!, 16);
    const low = Number.parseInt(mapped[2]!, 16);
    return [high >> 8, high & 255, low >> 8, low & 255].join('.');
  }
  return null;
}

export function selectRequestNetwork(input: {
  headers: Record<string, Header>;
  peer: string | undefined;
  edgeToken: string;
  railwayHttpIngress: boolean;
}): { address: string | null; country: string | null } {
  const { headers } = input;
  const token = headers['x-ow-geo-token'];
  const fromVercel = typeof token === 'string' && tokenMatches(token, input.edgeToken);
  const country = headers['x-ow-country'];
  return {
    address: (fromVercel ? singleIp(headers['x-ow-client-ip']) : null)
      // Railway перезаписывает X-Real-IP на публичном HTTP-входе.
      ?? (input.railwayHttpIngress ? singleIp(headers['x-real-ip']) : null)
      ?? singleIp(input.peer),
    country: fromVercel && typeof country === 'string' ? knownCountry(country) : null,
  };
}

const railwayHttpIngress = env.NODE_ENV === 'production'
  && Boolean(process.env.RAILWAY_SERVICE_ID && process.env.RAILWAY_PUBLIC_DOMAIN);

export function requestNetwork(req: FastifyRequest) {
  return selectRequestNetwork({
    headers: req.headers,
    peer: req.raw.socket.remoteAddress,
    edgeToken: env.GEO_EDGE_TOKEN,
    railwayHttpIngress,
  });
}
