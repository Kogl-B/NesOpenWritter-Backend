import { logger } from './logger.js';



/**
 * Курсы валют НБ РБ (https://api.nbrb.by/exrates). Базовая валюта цен — BYN,
 * USD и RUB пересчитываются. Обновление — один раз в сутки после 12:00
 * по минскому времени: «дневной якорь» = дата последнего наступившего 12:00;
 * пока якорь не сменился, кэш валиден и API не дёргается.
 */

export interface RateInfo {
  code: string;
  /** BYN за `scale` единиц валюты (у RUB scale=100). */
  rate: number;
  scale: number;
  /** Дата курса от НБ РБ. */
  updatedAt: string;
}

export interface RatesBundle {
  USD: RateInfo;
  RUB: RateInfo;
  fetchedAt: string;
  /** Дата последнего наступившего 12:00 по Минску, к которому относится кэш. */
  anchor: string;
  /** true — НБ РБ был недоступен, отдаём последние известные курсы. */
  stale: boolean;
  /** Epoch-ms: когда можно повторить запрос после неудачи. */
  retryAfter: number;
}

const NBRB_URL = 'https://api.nbrb.by/exrates/rates?periodicity=0';
const FETCH_TIMEOUT_MS = 8000;
const STALE_RETRY_MS = 10 * 60 * 1000;
const WARMUP_INTERVAL_MS = 60 * 60 * 1000;

const FALLBACK_USD = { rate: 3.0637, scale: 1 };
const FALLBACK_RUB = { rate: 3.5893, scale: 100 };

let cache: RatesBundle | null = null;
let inflight: Promise<RatesBundle> | null = null;

/** Сейчас по Минску (UTC+3, без перехода на летнее время). */
function minskNow(): Date {
  return new Date(Date.now() + 3 * 3600 * 1000);
}

/** Дата последнего наступившего 12:00 по Минску. */
function currentAnchor(): string {
  const m = minskNow();
  if (m.getUTCHours() < 12) m.setUTCDate(m.getUTCDate() - 1);
  return m.toISOString().slice(0, 10);
}

interface NbrbRow {
  Cur_Abbreviation: string;
  Cur_Scale: number;
  Cur_OfficialRate: number;
  Date: string;
}

async function fetchNbRb(): Promise<{ USD: RateInfo; RUB: RateInfo } | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(NBRB_URL, { signal: ctrl.signal });
    if (!res.ok) return null;
    const list = (await res.json()) as NbrbRow[];
    const usd = list.find((r) => r.Cur_Abbreviation === 'USD');
    const rub = list.find((r) => r.Cur_Abbreviation === 'RUB');
    if (!usd || !rub) return null;
    return {
      USD: { code: 'USD', rate: usd.Cur_OfficialRate, scale: usd.Cur_Scale, updatedAt: usd.Date },
      RUB: { code: 'RUB', rate: rub.Cur_OfficialRate, scale: rub.Cur_Scale, updatedAt: rub.Date },
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function getRates(): Promise<RatesBundle> {
  const anchor = currentAnchor();
  const now = Date.now();
  if (
    cache &&
    (cache.anchor === anchor || (cache.stale && now < cache.retryAfter))
  ) {
    return cache;
  }
  if (inflight) return inflight;

  inflight = (async () => {
    const fetched = await fetchNbRb();
    const next: RatesBundle = fetched
      ? {
          USD: fetched.USD,
          RUB: fetched.RUB,
          fetchedAt: new Date().toISOString(),
          anchor,
          stale: false,
          retryAfter: 0,
        }
      : {
          // НБ РБ недоступен: держим последние известные (или дефолт),
          // повторяем не чаще раза в 10 минут
          USD: cache?.USD ?? { code: 'USD', ...FALLBACK_USD, updatedAt: new Date().toISOString() },
          RUB: cache?.RUB ?? { code: 'RUB', ...FALLBACK_RUB, updatedAt: new Date().toISOString() },
          fetchedAt: new Date().toISOString(),
          anchor,
          stale: true,
          retryAfter: now + STALE_RETRY_MS,
        };
    cache = next;
    if (fetched) {
      logger.info(
        `НБ РБ курсы обновлены (якорь ${anchor}): USD=${fetched.USD.rate}/${fetched.USD.scale}, RUB=${fetched.RUB.rate}/${fetched.RUB.scale}`
      );
    } else {
      logger.warn(`НБ РБ недоступен (якорь ${anchor}) — работаем на ${cache && !cache.stale ? 'кэше' : 'резервных курсах'}`);
    }
    return next;
  })();
  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}

/** Сколько BYN стоит 1 единица валюты. */
export function bynPerUnit(r: RateInfo): number {
  return r.rate / r.scale;
}

// Часовой прогрев: курс обновляется в первый тик после 12:00 по Минску
// даже если никто не открывает кабинет
const warmup = setInterval(() => {
  void getRates().catch(() => undefined);
}, WARMUP_INTERVAL_MS);
warmup.unref?.();
