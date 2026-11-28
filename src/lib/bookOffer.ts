import { z } from 'zod';

export const bookOfferSchema = z.object({
  regular: z.number().int().positive().max(100_000_000),
  discounted: z.number().int().nonnegative(),
  currency: z.enum(['RUB', 'BYN', 'USD']),
  expiresAt: z.string().datetime({ offset: true }),
  href: z.string().trim().max(1500).url().refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && !url.username && !url.password;
    } catch {
      return false;
    }
  }, 'Укажите ссылку HTTPS без учётных данных'),
}).strict().refine((offer) => offer.discounted < offer.regular, 'Цена со скидкой должна быть ниже обычной');

export type BookOffer = z.infer<typeof bookOfferSchema>;

export function bookOfferOf(settings: unknown, includeExpired = false, now = Date.now()): BookOffer | null {
  const source = settings && typeof settings === 'object' ? (settings as { bookOffer?: unknown }).bookOffer : undefined;
  const result = bookOfferSchema.safeParse(source);
  if (!result.success || (!includeExpired && Date.parse(result.data.expiresAt) <= now)) return null;
  return result.data;
}
