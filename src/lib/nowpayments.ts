import { createHmac, timingSafeEqual } from 'node:crypto';

/** Тот же контур, что у TISMOS: счёт NOWPayments в USD, IPN с HMAC-SHA512. */
export const NOWPAYMENTS_API = 'https://api.nowpayments.io/v1';

export function cryptoPaymentsEnabled(): boolean {
  return process.env.CRYPTO_PAYMENTS_ENABLED === 'true';
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
