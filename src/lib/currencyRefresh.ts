import { logger } from './logger.js';

const REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;
const MINSK_OFFSET_MS = 3 * 60 * 60 * 1000;

export function currencyRefreshSlot(now: number): number {
  return Math.floor((now + MINSK_OFFSET_MS) / REFRESH_INTERVAL_MS) * REFRESH_INTERVAL_MS - MINSK_OFFSET_MS;
}

export function scheduleCurrencyRefresh(refresh: () => Promise<unknown>): void {
  function schedule() {
    const now = Date.now();
    const delay = currencyRefreshSlot(now) + REFRESH_INTERVAL_MS - now;
    const timer = setTimeout(() => {
      schedule();
      void refresh().catch(err => logger.error({ err }, 'Не удалось обновить курсы валют по расписанию'));
    }, delay);
    timer.unref?.();
  }
  schedule();
}
