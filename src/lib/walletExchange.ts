export const EXCHANGE_RATE_SCALE = 10_000;

export function exchangeCents(
  direction: 'to-ai' | 'to-wallet',
  amountCents: number,
  rateUnits: number,
): number {
  const amount = BigInt(amountCents);
  const rate = BigInt(rateUnits);
  const scale = BigInt(EXCHANGE_RATE_SCALE);
  return Number(direction === 'to-ai' ? amount * scale / rate : amount * rate / scale);
}
