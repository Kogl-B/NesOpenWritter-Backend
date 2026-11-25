import { z } from 'zod';
import { env } from './env.js';
import { prisma } from './prisma.js';

export const publisherPattern = /^pub-\d{16}$/;
const columns = ['DATE', 'AD_UNIT_ID', 'AD_REQUESTS', 'MATCHED_AD_REQUESTS', 'IMPRESSIONS', 'CLICKS', 'ESTIMATED_EARNINGS', 'ACTIVE_VIEW_MEASURABILITY', 'ACTIVE_VIEW_VIEWABILITY'] as const;
const cells = z.object({ cells: z.array(z.object({ value: z.string() })) });
const providerReport = z.object({
  totalMatchedRows: z.string().regex(/^\d+$/).default('0'),
  headers: z.array(z.object({ name: z.string(), currencyCode: z.string().optional() })),
  rows: z.array(cells).default([]),
});

export function validDay(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString().slice(0, 10) === value;
}

export function adsenseDay(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
}

export function previousDay(today: string, days: number): string {
  return new Date(Date.parse(today) - days * 86_400_000).toISOString().slice(0, 10);
}

export function adsenseCredentialsReady(): boolean {
  return Boolean(env.ADSENSE_CLIENT_ID && env.ADSENSE_CLIENT_SECRET && env.ADSENSE_REFRESH_TOKEN);
}

function optionalRate(value: string | undefined): string | null {
  if (value === '' || value === '--') return null;
  if (!value || !/^(0|1)(\.\d{1,9})?$/.test(value) || Number(value) > 1) {
    throw new Error('AdSense returned an invalid viewability metric');
  }
  return value;
}

export function parseAdSenseReport(input: unknown, from: string, to: string) {
  const report = providerReport.parse(input);
  if (BigInt(report.totalMatchedRows) !== BigInt(report.rows.length)
    || columns.some((name, i) => report.headers[i]?.name !== name)) {
    throw new Error('AdSense returned an incomplete report or unexpected columns');
  }
  const currency = report.headers[6]?.currencyCode;
  if (!currency || !/^[A-Z]{3}$/.test(currency)) throw new Error('AdSense report currency is missing');

  const keys = new Set<string>();
  return report.rows.map(({ cells: row }) => {
    const [day = '', unit = '', requests, matched, impressions, clicks, earnings = '', measurable, viewable] = row.map(c => c.value);
    const counts = [requests, matched, impressions, clicks];
    if (!validDay(day) || day < from || day > to || !unit || unit.length > 100 || keys.has(day + ':' + unit)
      || counts.some(c => !c || !/^\d{1,15}$/.test(c)) || !/^-?\d{1,15}(\.\d{1,6})?$/.test(earnings)) {
      throw new Error('AdSense returned invalid or duplicate report rows');
    }
    keys.add(day + ':' + unit);
    return {
      day, unit, currency, earnings, measurability: optionalRate(measurable), viewability: optionalRate(viewable), requests: BigInt(requests!), matched: BigInt(matched!),
      impressions: BigInt(impressions!), clicks: BigInt(clicks!),
    };
  });
}

export function adsenseReportUrl(publisherId: string, from: string, to: string): URL {
  if (!publisherPattern.test(publisherId)) throw new Error('Invalid AdSense publisher');
  const url = new URL(`https://adsense.googleapis.com/v2/accounts/${publisherId}/reports:generate`);
  for (const dimension of columns.slice(0, 2)) url.searchParams.append('dimensions', dimension);
  for (const metric of columns.slice(2)) url.searchParams.append('metrics', metric);
  for (const [key, date] of [['startDate', from], ['endDate', to]] as const) {
    const [year, month, day] = date.split('-');
    url.searchParams.set(`${key}.year`, year!);
    url.searchParams.set(`${key}.month`, String(Number(month)));
    url.searchParams.set(`${key}.day`, String(Number(day)));
  }
  url.searchParams.set('dateRange', 'CUSTOM');
  url.searchParams.set('reportingTimeZone', 'GOOGLE_TIME_ZONE');
  url.searchParams.append('filters', `DOMAIN_NAME==${env.ADSENSE_DOMAIN}`);
  url.searchParams.set('limit', '5000');
  return url;
}

let activeSync = false;

export async function syncAdSense(publisherId: string, from: string, to: string) {
  if (!adsenseCredentialsReady()) return { status: 'credentials' } as const;
  if (activeSync) return { status: 'busy' } as const;
  activeSync = true;
  try {
    const token = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      body: new URLSearchParams({
        client_id: env.ADSENSE_CLIENT_ID, client_secret: env.ADSENSE_CLIENT_SECRET,
        refresh_token: env.ADSENSE_REFRESH_TOKEN, grant_type: 'refresh_token',
      }),
      signal: AbortSignal.timeout(5000),
    });
    if (!token.ok) throw new Error(`AdSense OAuth returned HTTP ${token.status}`);
    const { access_token } = z.object({ access_token: z.string().min(1) }).parse(await token.json());
    const response = await fetch(adsenseReportUrl(publisherId, from, to), {
      headers: { authorization: `Bearer ${access_token}` }, signal: AbortSignal.timeout(9000),
    });
    if (!response.ok) throw new Error(`AdSense reports API returned HTTP ${response.status}`);
    const rows = parseAdSenseReport(await response.json(), from, to).map(row => ({ ...row, publisherId }));
    const now = new Date();
    const sync = await prisma.$transaction(async tx => {
      // Serialize overlapping replacements for the same publisher across replicas.
      await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtextextended(${'adsense:' + publisherId}, 0))`;
      await tx.adSenseDay.deleteMany({ where: { publisherId, day: { gte: from, lte: to } } });
      if (rows.length) await tx.adSenseDay.createMany({ data: rows });
      return tx.adSenseSync.upsert({
        where: { publisherId }, create: { publisherId, from, to, syncedAt: now }, update: { from, to, syncedAt: now },
      });
    }, { timeout: 6000 });
    return { status: 'ok', rows: rows.length, sync } as const;
  } finally {
    activeSync = false;
  }
}
