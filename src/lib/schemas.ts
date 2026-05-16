import { z } from 'zod';

export const projectCreateSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  settings: z.record(z.unknown()).optional(),
});

export const projectUpdateSchema = projectCreateSchema.partial();

export type ProjectCreateInput = z.infer<typeof projectCreateSchema>;
export type ProjectUpdateInput = z.infer<typeof projectUpdateSchema>;

const characterStatusEnum = z.enum(['alive', 'dead', 'unknown', 'missing']);

export const characterCreateSchema = z.object({
  name: z.string().min(1).max(200),
  shortName: z.string().max(100).nullish(),
  portraitPath: z.string().max(500).nullish(),
  summary: z.string().max(2000).nullish(),
  biography: z.string().nullish(),
  faction: z.string().max(200).nullish(),
  status: characterStatusEnum.optional(),
  dateOfBirth: z.string().max(50).nullish(),
  dateOfDeath: z.string().max(50).nullish(),
  traits: z.array(z.string()).optional(),
  abilities: z.array(z.string()).optional(),
  metadata: z.record(z.unknown()).optional(),
});

export const characterUpdateSchema = characterCreateSchema.partial();

export type CharacterCreateInput = z.infer<typeof characterCreateSchema>;
export type CharacterUpdateInput = z.infer<typeof characterUpdateSchema>;
