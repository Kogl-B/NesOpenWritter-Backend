import { prisma } from './prisma.js';

const sharedSections = new Set([
  'character-positions', 'character-relations', 'characters', 'collaborators', 'genealogy', 'items',
  'locations', 'events', 'map-drawings', 'map-elements', 'calendars', 'calculators', 'economy',
  'investigation', 'knowledge', 'snapshots', 'tag-links', 'tags', 'traits', 'wiki', 'wikibooks', 'world-facts', 'world-inbox', 'world-tables', 'manuscript-directory',
]);

const sharedSettings = new Set([
  'worldTables', 'worldLayout', 'worldLaws', 'worldBlocks', 'worldNotes', 'worldCanvas', 'worldDesk', 'worldDeskLayout',
  'worldInbox', 'worldFacts', 'worldLooks', 'characterMarks', 'systemModules', 'rpgGear', 'economyMarket', 'calendar',
]);

export function isUniverseSection(section: string) {
  return sharedSections.has(section);
}

export function settingsRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function splitBookSettings(value: unknown) {
  const book: Record<string, unknown> = {};
  const world: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(settingsRecord(value))) {
    (sharedSettings.has(key) ? world : book)[key] = entry;
  }
  return { book, world };
}

export async function universeProjectId(bookId: string) {
  const record = await prisma.project.findUnique({ where: { id: bookId }, select: { universeId: true } });
  return record?.universeId ?? bookId;
}
