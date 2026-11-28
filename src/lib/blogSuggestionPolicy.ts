export const suggestionDayMs = 24 * 60 * 60 * 1000;
export const maxSuggestions = 50;

export type SuggestionStatus = {
  stage: 'available' | 'cooldown' | 'blocked';
  retryAt: string | null;
  requested: boolean;
};

export function suggestionStatus(
  now: Date,
  sent: { count: number; latest: Date | undefined },
  limit: { blockedUntil: Date | null; requestedAt: Date | null } | null,
): SuggestionStatus {
  const rememberedBlock = limit?.blockedUntil?.getTime() ?? 0;
  const latest = sent.latest?.getTime() ?? 0;
  const block = sent.count >= maxSuggestions ? Math.max(rememberedBlock, latest + suggestionDayMs) : rememberedBlock;
  if (block > now.getTime()) {
    return { stage: 'blocked', retryAt: new Date(block).toISOString(), requested: !!limit?.requestedAt };
  }
  if (sent.count > 0 && sent.latest) {
    const minutes = sent.count <= 4 ? 5 : sent.count <= 9 ? 10 : 15;
    const retryAt = latest + minutes * 60_000;
    if (retryAt > now.getTime()) return { stage: 'cooldown', retryAt: new Date(retryAt).toISOString(), requested: false };
  }
  return { stage: 'available', retryAt: null, requested: false };
}
