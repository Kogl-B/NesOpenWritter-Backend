import { getCbrRates } from './cbrRates.js';
import { bynPerUnit, getRates } from './currency.js';

export const CURRENCIES = ['BYN', 'RUB', 'USD'] as const;
export type Currency = (typeof CURRENCIES)[number];
type Source = 'NBRB' | 'CBR' | 'USD';
const SCALE = 100_000_000;
const INT_MAX = 2_147_483_647;

export type CurrencyQuote = {
  id: string;
  from: Currency;
  to: Currency;
  inputCents: number;
  outputCents: number;
  rate: number;
  source: Source;
  date: string | null;
};

export function paymentQuote(
  from: Currency, to: Currency, inputCents: number,
  weights: { [K in Currency]?: number }, source: Source, date: string | null, rounding: 'down' | 'nearest',
): CurrencyQuote | null {
  const numerator = Math.round((weights[from] ?? 0) * SCALE);
  const denominator = Math.round((weights[to] ?? 0) * SCALE);
  if (![numerator, denominator].every(item => Number.isSafeInteger(item) && item > 0)) return null;
  const scale = BigInt(denominator);
  const gross = BigInt(inputCents) * BigInt(numerator);
  const outputCents = Number((gross + (rounding === 'nearest' ? scale / 2n : 0n)) / scale);
  if (!Number.isSafeInteger(outputCents) || outputCents > INT_MAX) return null;
  const id = [from, to, inputCents, numerator, denominator, source, date ?? 'identity', rounding].join(':');
  return { id, from, to, inputCents, outputCents, rate: numerator / denominator, source, date };
}

export async function walletQuote(from: Currency, to: Currency, cents: number) {
  const rates = await getRates();
  if (rates.stale) return null;
  return paymentQuote(from, to, cents, {
    BYN: 1, USD: bynPerUnit(rates.USD), RUB: bynPerUnit(rates.RUB),
  }, 'NBRB', rates.USD.updatedAt.slice(0, 10), 'down');
}

export async function nowPaymentsQuote(currency: Currency, cents: number) {
  if (currency === 'USD') return paymentQuote('USD', 'USD', cents, { USD: 1 }, 'USD', null, 'nearest');
  if (currency === 'RUB') {
    const cbr = await getCbrRates();
    return cbr && paymentQuote('RUB', 'USD', cents, { RUB: 1, USD: cbr.USD.rubles / cbr.USD.nominal },
      'CBR', cbr.date, 'nearest');
  }
  const rates = await getRates();
  return rates.stale ? null : paymentQuote('BYN', 'USD', cents, { BYN: 1, USD: bynPerUnit(rates.USD) },
    'NBRB', rates.USD.updatedAt.slice(0, 10), 'nearest');
}

export async function currencySources() {
  const [nbrb, cbr] = await Promise.all([getRates(), getCbrRates()]);
  return {
    currencies: CURRENCIES,
    banks: {
      NBRB: { base: 'BYN', date: nbrb.USD.updatedAt.slice(0, 10), available: !nbrb.stale,
        rates: nbrb.stale ? null : { USD: bynPerUnit(nbrb.USD), RUB: bynPerUnit(nbrb.RUB) } },
      CBR: { base: 'RUB', date: cbr?.date ?? null, available: cbr !== null,
        rates: cbr && { BYN: cbr.BYN.rubles / cbr.BYN.nominal, USD: cbr.USD.rubles / cbr.USD.nominal } },
    },
    paymentCurrencies: { wallet: CURRENCIES, subscriptions: 'BYN', donations: 'BYN', nowpayments: 'USD', ai: 'USD' },
  };
}
