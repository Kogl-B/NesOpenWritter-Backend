import { z } from 'zod';

export const blogAppearanceSchema = z.object({
  theme: z.enum(['forest', 'ocean', 'plum', 'amber']).default('forest'),
  layout: z.enum(['cards', 'compact']).default('cards'),
  showDiscussions: z.boolean().default(true),
  showTopics: z.boolean().default(true),
});

export function readBlogAppearance(value: unknown) {
  const parsed = blogAppearanceSchema.safeParse(value ?? {});
  return parsed.success ? parsed.data : blogAppearanceSchema.parse({});
}
