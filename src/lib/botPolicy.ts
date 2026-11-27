export const ROBOTS_TAG = 'noindex, nofollow, noarchive, nosnippet, noimageindex, noai, noimageai';

export function blockedAutomation(userAgent: string | undefined): boolean {
  return /(?:bot\b|crawler\b|spider\b|slurp\b|chatgpt-user|claude-web|perplexity-user|omgili|bytespider|cohere-ai)/i.test(userAgent ?? '');
}
