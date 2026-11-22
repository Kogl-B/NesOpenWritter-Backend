import { createRequire } from 'node:module';

import { knownCountry } from './countries.js';

interface GeoHit {
  country?: string;
}

const require = createRequire(import.meta.url);
let lookup: ((ip: string) => GeoHit | null) | null = null;

function geoLookup(): (ip: string) => GeoHit | null {
  if (!lookup) {
    const mod = require('geoip-lite') as { lookup: (ip: string) => GeoHit | null };
    lookup = mod.lookup;
  }
  return lookup;
}

/** Страна по публичному IP. Нет в базе — null, ограничение тогда не срабатывает. */
export function countryOfIp(ip: string | null): string | null {
  if (!ip) return null;
  const hit = geoLookup()(ip);
  return knownCountry(hit?.country ?? '');
}
