import { z } from 'zod';

// ----- helpers --------------------------------------------------------------

const jsonObject = z.record(z.unknown());
const nullableString = z.string().nullish();
const nullableId = z.string().min(1).nullish();

// ----- Project --------------------------------------------------------------

export const projectCreateSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().max(2000).optional(),
  settings: jsonObject.optional(),
});

export const projectUpdateSchema = projectCreateSchema.partial();

// ----- Character ------------------------------------------------------------

const characterStatusEnum = z.enum(['alive', 'dead', 'unknown', 'missing']);

export const characterCreateSchema = z.object({
  name: z.string().trim().min(1).max(200),
  shortName: z.string().max(100).nullish(),
  portraitPath: z.string().max(500).nullish(),
  summary: z.string().max(2000).nullish(),
  biography: z.string().nullish(),
  faction: z.string().max(200).nullish(),
  status: characterStatusEnum.optional(),
  // «год/эпоха» — свободный текст, но без мусора вроде «abc»
  dateOfBirth: z
    .string()
    .max(50)
    .refine((v) => /[0-9а-яёА-ЯЁ]/i.test(v), 'Дата рождения: используйте цифры или кириллицу')
    .nullish(),
  dateOfDeath: z
    .string()
    .max(50)
    .refine((v) => /[0-9а-яёА-ЯЁ]/i.test(v), 'Дата смерти: используйте цифры или кириллицу')
    .nullish(),
  traits: z.array(z.string()).optional(),
  abilities: z.array(z.string()).optional(),
  metadata: jsonObject.optional(),
});

export const characterUpdateSchema = characterCreateSchema.partial();

// ----- CharacterRelation ----------------------------------------------------

export const characterRelationCreateSchema = z.object({
  fromCharacterId: z.string().min(1),
  toCharacterId: z.string().min(1),
  relationType: z.string().min(1).max(50),
  strength: z.number().int().min(0).max(100).optional(),
  description: z.string().max(1000).nullish(),
});

export const characterRelationUpdateSchema = z.object({
  relationType: z.string().min(1).max(50).optional(),
  strength: z.number().int().min(0).max(100).optional(),
  description: z.string().max(1000).nullish(),
});

// ----- Genealogy ------------------------------------------------------------

export const genealogyCreateSchema = z.object({
  parentId: z.string().min(1),
  childId: z.string().min(1),
  kind: z.string().min(1).max(50).optional(),
});

// ----- Item -----------------------------------------------------------------

export const itemCreateSchema = z.object({
  name: z.string().trim().min(1).max(200),
  shortName: nullableString,
  imagePath: nullableString,
  category: z.string().max(50).optional(),
  rarity: z.string().max(50).optional(),
  summary: nullableString,
  description: nullableString,
  properties: jsonObject.optional(),
  currentOwnerId: nullableId,
  currentLocationId: nullableId,
  metadata: jsonObject.optional(),
});

export const itemUpdateSchema = itemCreateSchema.partial();

export const itemTimelinePointCreateSchema = z.object({
  at: z.string().min(1).max(50),
  ownerId: nullableId,
  locationId: nullableId,
  eventId: nullableId,
  note: nullableString,
  orderIndex: z.number().int().optional(),
});

export const itemTimelinePointUpdateSchema = itemTimelinePointCreateSchema.partial();

// ----- Location -------------------------------------------------------------

export const locationCreateSchema = z.object({
  name: z.string().trim().min(1).max(200),
  shortName: nullableString,
  kind: z.string().max(50).optional(),
  parentLocationId: nullableId,
  lodLevel: z.number().int().min(0).max(10).optional(),
  coordX: z.number().nullish(),
  coordY: z.number().nullish(),
  description: nullableString,
  metadata: jsonObject.optional(),
});

export const locationUpdateSchema = locationCreateSchema.partial();

// ----- TimelineEvent --------------------------------------------------------

export const eventCreateSchema = z.object({
  name: z.string().trim().min(1).max(200),
  summary: nullableString,
  description: nullableString,
  at: z.string().min(1).max(100),
  atNumeric: z.number().nullish(),
  durationNumeric: z.number().nullish(),
  locationId: nullableId,
  color: z.string().max(20).nullish(),
  icon: z.string().max(50).nullish(),
  importance: z.number().int().min(1).max(5).optional(),
  metadata: jsonObject.optional(),
});

export const eventUpdateSchema = eventCreateSchema.partial();

export const eventCharacterCreateSchema = z.object({
  characterId: z.string().min(1),
  role: z.string().max(50).optional(),
  note: nullableString,
});

export const eventCharacterUpdateSchema = z.object({
  role: z.string().max(50).optional(),
  note: nullableString,
});

export const eventItemCreateSchema = z.object({
  itemId: z.string().min(1),
  note: nullableString,
});

export const eventItemUpdateSchema = z.object({
  note: nullableString,
});

// ----- CharacterPosition ----------------------------------------------------

export const characterPositionCreateSchema = z.object({
  characterId: z.string().min(1),
  eventId: z.string().min(1),
  locationId: nullableId,
  coordX: z.number().nullish(),
  coordY: z.number().nullish(),
  metadata: jsonObject.optional(),
});

export const characterPositionUpdateSchema = z.object({
  locationId: nullableId,
  coordX: z.number().nullish(),
  coordY: z.number().nullish(),
  metadata: jsonObject.optional(),
});

// ----- Chapter --------------------------------------------------------------

const chapterKindEnum = z.enum(['chapter', 'scene']);

export const chapterCreateSchema = z.object({
  parentId: nullableId,
  kind: chapterKindEnum,
  title: z.string().trim().min(1).max(300),
  summary: nullableString,
  content: jsonObject.optional(),
  orderIndex: z.number().int().optional(),
  wordCount: z.number().int().min(0).optional(),
  eventId: nullableId,
  locationId: nullableId,
  metadata: jsonObject.optional(),
});

export const chapterUpdateSchema = chapterCreateSchema.partial();

// ----- Tag ------------------------------------------------------------------

export const taggableEntityTypeEnum = z.enum([
  'character',
  'item',
  'location',
  'event',
  'chapter',
  'scene',
]);

export const tagCreateSchema = z.object({
  name: z.string().trim().min(1).max(100),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional(),
  description: nullableString,
});

export const tagUpdateSchema = tagCreateSchema.partial();

export const tagAssignSchema = z.object({
  entityType: taggableEntityTypeEnum,
  entityId: z.string().min(1),
});

// ----- MapElement -----------------------------------------------------------

const markerGeom = z.object({ x: z.number(), y: z.number() });
const pointsGeom = z.object({
  points: z.array(z.tuple([z.number(), z.number()])).min(1),
});
const geometrySchema = z.union([markerGeom, pointsGeom]);

const mapElementKindEnum = z.enum(['marker', 'line', 'area']);

export const mapElementCreateSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: nullableString,
  kind: mapElementKindEnum,
  subkind: nullableString,
  locationId: nullableId,
  geometry: geometrySchema,
  style: jsonObject.optional(),
  lodMin: z.number().int().min(0).max(10).optional(),
  lodMax: z.number().int().min(0).max(10).optional(),
  metadata: jsonObject.optional(),
}).superRefine((data, ctx) => {
  if (data.lodMin !== undefined && data.lodMax !== undefined && data.lodMin > data.lodMax) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['lodMin'],
      message: 'lodMin не может быть больше lodMax',
    });
  }
});

export const mapElementUpdateSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  description: nullableString.optional(),
  kind: mapElementKindEnum.optional(),
  subkind: nullableString.optional(),
  locationId: nullableId.optional(),
  geometry: geometrySchema.optional(),
  style: jsonObject.optional(),
  lodMin: z.number().int().min(0).max(10).optional(),
  lodMax: z.number().int().min(0).max(10).optional(),
  metadata: jsonObject.optional(),
}).superRefine((data, ctx) => {
  if (data.lodMin !== undefined && data.lodMax !== undefined && data.lodMin > data.lodMax) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['lodMin'],
      message: 'lodMin не может быть больше lodMax',
    });
  }
});

// ----- MapDrawing -----------------------------------------------------------

export const mapDrawingCreateSchema = z.object({
  name: z.string().trim().min(1).max(200),
  layer: z.string().max(100).optional(),
  payload: jsonObject.optional(),
});

export const mapDrawingUpdateSchema = mapDrawingCreateSchema.partial();

// ----- R2 presigned upload --------------------------------------------------

export const presignUploadSchema = z.object({
  filename: z.string().trim().min(1).max(255),
  contentType: z.string().min(1).max(100),
  kind: z.enum(['portrait', 'item', 'map', 'other']).default('other'),
  sizeBytes: z.number().int().positive().max(50 * 1024 * 1024).optional(),
});

// ----- Chapter content / revisions / mentions (Этап 4) ----------------------

export const chapterContentSchema = z.object({
  content: jsonObject,
  wordCount: z.number().int().min(0).optional(),
});

export const chapterReorderItemSchema = z.object({
  id: z.string().min(1),
  parentId: nullableId,
  orderIndex: z.number().int(),
});

export const chapterReorderSchema = z.object({
  items: z.array(chapterReorderItemSchema).min(1),
});

const sceneMentionInputSchema = z.object({
  entityType: taggableEntityTypeEnum,
  entityId: z.string().min(1),
  count: z.number().int().positive().optional(),
});

export const sceneMentionsReplaceSchema = z.object({
  mentions: z.array(sceneMentionInputSchema),
});

export const chapterRevisionCreateSchema = z.object({
  label: z.string().max(200).nullish(),
});

// ----- User settings (Этап 6) -----------------------------------------------

export const userSettingsUpdateSchema = z.object({
  settings: jsonObject,
});

// ----- Search (Этап 6) ------------------------------------------------------

export const searchQuerySchema = z.object({
  q: z.string().min(1).max(200),
  types: z
    .string()
    .optional()
    .transform((v) =>
      v
        ? v
            .split(',')
            .map((s) => s.trim())
            .filter((s) => s.length > 0)
        : undefined,
    ),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

// ----- Frontend logs (Этап 6) -----------------------------------------------

const logEntrySchema = z.object({
  level: z.enum(['error', 'warn', 'info', 'debug']),
  message: z.string().max(2000),
  timestamp: z.string().optional(),
  context: jsonObject.optional(),
});

export const logBatchSchema = z.object({
  entries: z.array(logEntrySchema).min(1).max(100),
});

// ----- export types --------------------------------------------------------

export type ProjectCreateInput = z.infer<typeof projectCreateSchema>;
export type ProjectUpdateInput = z.infer<typeof projectUpdateSchema>;
export type CharacterCreateInput = z.infer<typeof characterCreateSchema>;
export type CharacterUpdateInput = z.infer<typeof characterUpdateSchema>;
export type ItemCreateInput = z.infer<typeof itemCreateSchema>;
export type ItemUpdateInput = z.infer<typeof itemUpdateSchema>;
export type LocationCreateInput = z.infer<typeof locationCreateSchema>;
export type LocationUpdateInput = z.infer<typeof locationUpdateSchema>;
export type EventCreateInput = z.infer<typeof eventCreateSchema>;
export type EventUpdateInput = z.infer<typeof eventUpdateSchema>;
export type ChapterCreateInput = z.infer<typeof chapterCreateSchema>;
export type ChapterUpdateInput = z.infer<typeof chapterUpdateSchema>;
export type TagCreateInput = z.infer<typeof tagCreateSchema>;
export type TagUpdateInput = z.infer<typeof tagUpdateSchema>;
