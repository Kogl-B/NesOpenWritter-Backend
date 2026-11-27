import { XMLParser } from 'fast-xml-parser';
import { logger } from './logger.js';
import { currencyRefreshSlot, scheduleCurrencyRefresh } from './currencyRefresh.js';

type Rate = { nominal: number; rubles: number };
export type CbrRates = { date: string; BYN: Rate; USD: Rate };

const XML_URL = 'https://www.cbr.ru/scripts/XML_daily.asp';
const parser = new XMLParser({
  ignoreAttributes: false,
  parseTagValue: false,
  processEntities: false,
  isArray: tag => tag === 'Valute',
});

export function parseCbrRates(xml: string): CbrRates | null {
  const parsed = parser.parse(xml);
  const data = parsed?.ValCurs;
  if (typeof data?.['@_Date'] !== 'string' || !Array.isArray(data.Valute)) return null;
  const match = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(data['@_Date']);
  if (!match) return null;
  const date = `${match[3]}-${match[2]}-${match[1]}`;
  if (!Number.isFinite(Date.parse(date))) return null;
  function row(code: string): Rate | null {
    const item = data.Valute.find((entry: { CharCode?: string }) => entry.CharCode === code);
    const nominal = Number(item?.Nominal);
    const rubles = Number(String(item?.Value).replace(',', '.'));
    return Number.isSafeInteger(nominal) && nominal > 0 && Number.isFinite(rubles) && rubles > 0
      ? { nominal, rubles } : null;
  }
  const BYN = row('BYN');
  const USD = row('USD');
  return BYN && USD ? { date, BYN, USD } : null;
}

const moscowDate = new Intl.DateTimeFormat('en-GB', {
  day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Europe/Moscow',
});
type CbrCache = { slot: number; retryAt: number; rates: CbrRates | null };
let cached: CbrCache | undefined;
let loading: Promise<CbrCache> | undefined;

export async function getCbrRates(): Promise<CbrRates | null> {
  const now = Date.now();
  const slot = currencyRefreshSlot(now);
  if (cached?.slot === slot && (cached.rates || cached.retryAt > now)) return cached.rates;
  if (loading) {
    const previous = await loading;
    return previous.slot === slot ? previous.rates : getCbrRates();
  }
  const day = moscowDate.format(new Date(now));

  loading = (async () => {
    let rates: CbrRates | null = null;
    try {
      const url = new URL(XML_URL);
      url.searchParams.set('date_req', day);
      const reply = await fetch(url, { signal: AbortSignal.timeout(8_000) });
      if (!reply.ok) throw Error('HTTP ' + reply.status);
      const parsed = parseCbrRates(new TextDecoder('windows-1251').decode(await reply.arrayBuffer()));
      const requested = Date.parse(day.split('/').reverse().join('-'));
      const age = parsed ? requested - Date.parse(parsed.date) : Infinity;
      if (age < 0 || age > 14 * 86_400_000) throw Error('Недействительная дата курса');
      rates = parsed;
    } catch (err) {
      logger.warn({ err, source: 'CBR' }, 'Курс Банка России недоступен');
    }
    cached = { slot, retryAt: Date.now() + 120_000, rates };
    return cached;
  })();
  try {
    return (await loading).rates;
  } finally {
    loading = undefined;
  }
}

scheduleCurrencyRefresh(getCbrRates);
