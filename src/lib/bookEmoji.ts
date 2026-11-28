import { z } from 'zod';

export const bookEmoji = z.enum(['like', 'heart', 'fire', 'clap', 'smile', 'book']);
export type BookEmoji = z.infer<typeof bookEmoji>;
export const bookEmojiChoices = z.array(bookEmoji).max(bookEmoji.options.length)
  .refine((values) => new Set(values).size === values.length, 'Не повторяйте реакции');

export function allowedBookEmoji(settings: unknown): readonly BookEmoji[] {
  const stored = settings && typeof settings === 'object' ? (settings as { bookEmojiChoices?: unknown }).bookEmojiChoices : undefined;
  const choices = bookEmojiChoices.safeParse(stored);
  return choices.success ? choices.data : bookEmoji.options;
}
