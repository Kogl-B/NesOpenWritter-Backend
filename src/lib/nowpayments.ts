import { createHmac, timingSafeEqual } from 'node:crypto';

/** Тот же контур, что у TISMOS: счёт NOWPayments в USD, IPN с HMAC-SHA512. */
export const NOWPAYMENTS_API = 'https://api.nowpayments.io/v1';
export const NOWPAYMENTS_SANDBOX_API = 'https://api-sandbox.nowpayments.io/v1';

/** Нижняя сумма счёта, как у криптопополнения TISMOS. */
export const MIN_DEPOSIT_USD = 5;
export const MAX_DEPOSIT_USD = 500;
export const DEPOSIT_TIERS_USD = [5, 10, 20, 50, 100, 200, 500] as const;

export function cryptoPaymentsEnabled(): boolean {
  return process.env.CRYPTO_PAYMENTS_ENABLED === 'true';
}

export function nowpaymentsSandbox(): boolean {
  return process.env.NOWPAYMENTS_SANDBOX === 'true';
}

export function nowpaymentsApiBase(): string {
  return nowpaymentsSandbox() ? NOWPAYMENTS_SANDBOX_API : NOWPAYMENTS_API;
}

/**
 * Сколько центов зачислить. `finished` — весь счёт.
 * `partially_paid` — доля actually_paid / pay_amount, не больше счёта.
 * Остальные статусы деньги не двигают.
 */
export function creditedCents(
  amountUsdCents: number,
  status: string,
  actuallyPaid?: number | string | null,
  payAmount?: number | string | null,
): number | null {
  if (status === 'finished') return amountUsdCents;
  if (status !== 'partially_paid') return null;
  const paid = Number(actuallyPaid);
  const due = Number(payAmount);
  if (!Number.isFinite(paid) || !Number.isFinite(due) || due <= 0 || paid <= 0) return 0;
  const ratio = Math.min(paid / due, 1);
  return Math.floor(amountUsdCents * ratio);
}

export interface InvoiceInput {
  amountUsd: number;
  orderId: string;
  description: string;
  ipnUrl: string;
  successUrl: string;
  cancelUrl: string;
}

/** Тело POST /v1/invoice. Монету покупатель выбирает на странице NOWPayments. */
export function buildInvoicePayload(input: InvoiceInput): Record<string, string | number> {
  return {
    price_amount: input.amountUsd,
    price_currency: 'usd',
    order_id: input.orderId,
    order_description: input.description,
    ipn_callback_url: input.ipnUrl,
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
  };
}

function dump(value: unknown, spaced: boolean): string {
  const comma = spaced ? ', ' : ',';
  const colon = spaced ? ': ' : ':';
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => dump(item, spaced)).join(comma)}]`;
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}${colon}${dump(obj[key], spaced)}`).join(comma)}}`;
  }
  return 'null';
}

/** Подпись IPN: HMAC-SHA512 от JSON с ключами по алфавиту. */
export function nowpaymentsSignature(payload: unknown, secret: string): string {
  return createHmac('sha512', secret).update(dump(payload, false)).digest('hex');
}

export function nowpaymentsSignatureValid(payload: unknown, signature: string, secret: string): boolean {
  if (!payload || typeof payload !== 'object' || !signature || !secret) return false;
  const key = Buffer.from(secret);
  const given = Buffer.from(signature);
  for (const spaced of [false, true]) {
    const expected = createHmac('sha512', key).update(dump(payload, spaced)).digest('hex');
    const buf = Buffer.from(expected);
    if (buf.length === given.length && timingSafeEqual(buf, given)) return true;
  }
  return false;
}
