import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';

import { prisma } from './prisma.js';

/**
 * Полный перенос проекта: экспорт всех таблиц в JSON и восстановление
 * в новый проект с перемаппингом всех идентификаторов и связей.
 * Формат: { version, exportedAt, project, tables } — таблицы с id,
 * который при импорте заменяется на свежие.
 */

export interface ProjectBackup {
  version: number;
  app: string;
  exportedAt: string;
  project: {
    name: string;
    description: string | null;
    settings: unknown;
  };
  tables: {
    locations: unknown[];
    characters: unknown[];
    characterRelations: unknown[];
    genealogyEdges: unknown[];
    items: unknown[];
    tags: unknown[];
    entityTags: unknown[];
    events: unknown[];
    eventCharacters: unknown[];
    eventItems: unknown[];
    characterPositions: unknown[];
    itemTimelinePoints: unknown[];
    chapters: unknown[];
    chapterRevisions: unknown[];
    mapElements: unknown[];
    mapDrawings: unknown[];
    wikiPages: unknown[];
    snapshots: unknown[];
    currencies: unknown[];
    resources: unknown[];
    tradeRoutes: unknown[];
    knowledgeEntries: unknown[];
    calendars: unknown[];
    traits: unknown[];
    investigationPins: unknown[];
    investigationThreads: unknown[];
  };
}

type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

export async function exportProjectFull(projectId: string): Promise<ProjectBackup> {
  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) {
    throw Object.assign(new Error('Project not found'), { statusCode: 404 });
  }
  const [
    locations,
    characters,
    characterRelations,
    genealogyEdges,
    items,
    tags,
    entityTags,
    events,
    eventCharacters,
    eventItems,
    characterPositions,
    itemTimelinePoints,
    chapters,
    chapterRevisions,
    mapElements,
    mapDrawings,
    wikiPages,
    snapshots,
    currencies,
    resources,
    tradeRoutes,
    knowledgeEntries,
    calendars,
    traits,
    investigationPins,
    investigationThreads,
  ] = await Promise.all([
    prisma.location.findMany({ where: { projectId } }),
    prisma.character.findMany({ where: { projectId } }),
    prisma.characterRelation.findMany({ where: { projectId } }),
    prisma.genealogyEdge.findMany({ where: { projectId } }),
    prisma.item.findMany({ where: { projectId } }),
    prisma.tag.findMany({ where: { projectId } }),
    prisma.entityTag.findMany({ where: { tag: { projectId } } }),
    prisma.timelineEvent.findMany({ where: { projectId } }),
    prisma.eventCharacter.findMany({ where: { event: { projectId } } }),
    prisma.eventItem.findMany({ where: { event: { projectId } } }),
    prisma.characterPosition.findMany({ where: { projectId } }),
    prisma.itemTimelinePoint.findMany({ where: { projectId } }),
    prisma.chapter.findMany({ where: { projectId } }),
    prisma.chapterRevision.findMany({ where: { chapter: { projectId } } }),
    prisma.mapElement.findMany({ where: { projectId } }),
    prisma.mapDrawing.findMany({ where: { projectId } }),
    prisma.wikiPage.findMany({ where: { projectId } }),
    prisma.worldSnapshot.findMany({ where: { projectId } }),
    prisma.currency.findMany({ where: { projectId } }),
    prisma.resource.findMany({ where: { projectId } }),
    prisma.tradeRoute.findMany({ where: { projectId } }),
    prisma.knowledgeEntry.findMany({ where: { projectId } }),
    prisma.calendar.findMany({ where: { projectId } }),
    prisma.traitInheritance.findMany({ where: { projectId } }),
    prisma.investigationPin.findMany({ where: { projectId } }),
    prisma.investigationThread.findMany({ where: { projectId } }),
  ]);

  return JSON.parse(
    JSON.stringify({
      version: 1,
      app: 'nesopenwritter',
      exportedAt: new Date().toISOString(),
      project: {
        name: project.name,
        description: project.description,
        settings: project.settings,
      },
      tables: {
        locations,
        characters,
        characterRelations,
        genealogyEdges,
        items,
        tags,
        entityTags,
        events,
        eventCharacters,
        eventItems,
        characterPositions,
        itemTimelinePoints,
        chapters,
        chapterRevisions,
        mapElements,
        mapDrawings,
        wikiPages,
        snapshots,
        currencies,
        resources,
        tradeRoutes,
        knowledgeEntries,
        calendars,
        traits,
        investigationPins,
        investigationThreads,
      },
    })
  ) as ProjectBackup;
}

// --- Импорт ---------------------------------------------------------------

type Row = Record<string, unknown>;

function rows(v: unknown): Row[] {
  return Array.isArray(v) ? (v as Row[]) : [];
}

/** Копия строки без служебных полей; id выдаём сразу и запоминаем в map. */
function takeRow(
  src: Row,
  map: Map<string, string>
): { id: string; data: Row } {
  const oldId = typeof src.id === 'string' ? src.id : '';
  const id = randomUUID();
  if (oldId) map.set(oldId, id);
  const data: Row = { ...src, id };
  delete data.createdAt;
  delete data.updatedAt;
  return { id, data };
}

/** Ссылка старый→новый; null/неизвестный → null. */
function ref(map: Map<string, string> | null, old: unknown): string | null {
  if (!map || typeof old !== 'string' || !old) return null;
  return map.get(old) ?? null;
}

/** Сортировка строк по глубине parent-ссылки (деревья без циклов сверху). */
function byParentDepth(list: Row[], parentKey: string): Row[] {
  const out: Row[] = [];
  const seen = new Set<Row>();
  let frontier = list.filter((r) => !r[parentKey] || !list.some((x) => x.id === r[parentKey]));
  while (frontier.length) {
    for (const r of frontier) {
      out.push(r);
      seen.add(r);
    }
    frontier = list.filter((r) => !seen.has(r) && r[parentKey] && seen.has(list.find((x) => x.id === r[parentKey])!));
  }
  // на случай циклов: добавляем остаток как есть
  for (const r of list) if (!seen.has(r)) out.push(r);
  return out;
}

export interface RestoreResult {
  projectId: string;
  counts: Record<string, number>;
}

export async function restoreProjectFull(
  ownerId: string,
  backup: ProjectBackup,
  nameSuffix = '(восстановлено)'
): Promise<RestoreResult> {
  if (!backup || backup.app !== 'nesopenwritter' || !backup.tables) {
    throw Object.assign(new Error('Файл не похож на бэкап OpenWritter'), { statusCode: 400 });
  }
  const t = backup.tables;
  const counts: Record<string, number> = {};
  const m = {
    location: new Map<string, string>(),
    character: new Map<string, string>(),
    item: new Map<string, string>(),
    tag: new Map<string, string>(),
    event: new Map<string, string>(),
    chapter: new Map<string, string>(),
    pin: new Map<string, string>(),
    currency: new Map<string, string>(),
  };

  const entityTypeMap = (entityType: unknown): Map<string, string> | null => {
    switch (entityType) {
      case 'character': return m.character;
      case 'item': return m.item;
      case 'location': return m.location;
      case 'event': return m.event;
      default: return null;
    }
  };

  const created = await prisma.$transaction(
    async (tx: Tx) => {
    const project = await tx.project.create({
      data: {
        ownerId,
        name: `${backup.project.name} ${nameSuffix}`.trim().slice(0, 200),
        description: backup.project.description ?? null,
        settings: (backup.project.settings ?? {}) as Prisma.InputJsonValue,
      },
    });

    // Локации (дерево)
    for (const src of byParentDepth(rows(t.locations), 'parentLocationId')) {
      const { data } = takeRow(src, m.location);
      data.projectId = project.id;
      data.parentLocationId = ref(m.location, src.parentLocationId);
      await tx.location.create({ data: data as never });
      counts.locations = (counts.locations ?? 0) + 1;
    }

    // Персонажи
    for (const src of rows(t.characters)) {
      const { data } = takeRow(src, m.character);
      data.projectId = project.id;
      await tx.character.create({ data: data as never });
      counts.characters = (counts.characters ?? 0) + 1;
    }
    for (const src of rows(t.characterRelations)) {
      const { data } = takeRow(src, new Map());
      data.projectId = project.id;
      data.fromCharacterId = ref(m.character, src.fromCharacterId) ?? '';
      data.toCharacterId = ref(m.character, src.toCharacterId) ?? '';
      if (data.fromCharacterId && data.toCharacterId) {
        await tx.characterRelation.create({ data: data as never });
        counts.characterRelations = (counts.characterRelations ?? 0) + 1;
      }
    }
    for (const src of rows(t.genealogyEdges)) {
      const { data } = takeRow(src, new Map());
      data.projectId = project.id;
      data.parentId = ref(m.character, src.parentId) ?? '';
      data.childId = ref(m.character, src.childId) ?? '';
      if (data.parentId && data.childId) {
        await tx.genealogyEdge.create({ data: data as never });
        counts.genealogyEdges = (counts.genealogyEdges ?? 0) + 1;
      }
    }

    // Предметы
    for (const src of rows(t.items)) {
      const { data } = takeRow(src, m.item);
      data.projectId = project.id;
      data.currentOwnerId = ref(m.character, src.currentOwnerId);
      data.currentLocationId = ref(m.location, src.currentLocationId);
      await tx.item.create({ data: data as never });
      counts.items = (counts.items ?? 0) + 1;
    }

    // Теги + связи
    for (const src of rows(t.tags)) {
      const { data } = takeRow(src, m.tag);
      data.projectId = project.id;
      await tx.tag.create({ data: data as never });
      counts.tags = (counts.tags ?? 0) + 1;
    }
    const entityTagRows = rows(t.entityTags)
      .map((src) => ({
        tagId: ref(m.tag, src.tagId)!,
        entityType: String(src.entityType ?? ''),
        entityId: ref(entityTypeMap(src.entityType), src.entityId) ?? '',
      }))
      .filter((r) => r.tagId && r.entityId);
    if (entityTagRows.length) {
      await tx.entityTag.createMany({ data: entityTagRows as never, skipDuplicates: true });
      counts.entityTags = entityTagRows.length;
    }

    // События
    for (const src of rows(t.events)) {
      const { data } = takeRow(src, m.event);
      data.projectId = project.id;
      data.locationId = ref(m.location, src.locationId);
      await tx.timelineEvent.create({ data: data as never });
      counts.events = (counts.events ?? 0) + 1;
    }
    const eventCharRows = rows(t.eventCharacters)
      .map((src) => ({
        eventId: ref(m.event, src.eventId)!,
        characterId: ref(m.character, src.characterId)!,
        role: String(src.role ?? 'participant'),
        note: (src.note as string | null) ?? null,
      }))
      .filter((r) => r.eventId && r.characterId);
    if (eventCharRows.length) {
      await tx.eventCharacter.createMany({ data: eventCharRows as never, skipDuplicates: true });
      counts.eventCharacters = eventCharRows.length;
    }
    const eventItemRows = rows(t.eventItems)
      .map((src) => ({
        eventId: ref(m.event, src.eventId)!,
        itemId: ref(m.item, src.itemId)!,
        note: (src.note as string | null) ?? null,
      }))
      .filter((r) => r.eventId && r.itemId);
    if (eventItemRows.length) {
      await tx.eventItem.createMany({ data: eventItemRows as never, skipDuplicates: true });
      counts.eventItems = eventItemRows.length;
    }
    const positionRows = rows(t.characterPositions)
      .map((src) => {
        const { data } = takeRow(src, new Map());
        data.projectId = project.id;
        data.characterId = ref(m.character, src.characterId) ?? '';
        data.eventId = ref(m.event, src.eventId) ?? '';
        data.locationId = ref(m.location, src.locationId);
        return data;
      })
      .filter((r) => r.characterId && r.eventId);
    for (const data of positionRows) {
      await tx.characterPosition.create({ data: data as never });
      counts.characterPositions = (counts.characterPositions ?? 0) + 1;
    }
    const itemTimelineRows = rows(t.itemTimelinePoints)
      .map((src) => {
        const { data } = takeRow(src, new Map());
        data.projectId = project.id;
        data.itemId = ref(m.item, src.itemId) ?? '';
        data.ownerId = ref(m.character, src.ownerId);
        data.locationId = ref(m.location, src.locationId);
        data.eventId = ref(m.event, src.eventId);
        return data;
      })
      .filter((r) => r.itemId);
    for (const data of itemTimelineRows) {
      await tx.itemTimelinePoint.create({ data: data as never });
      counts.itemTimelinePoints = (counts.itemTimelinePoints ?? 0) + 1;
    }

    // Главы (дерево) + ревизии
    for (const src of byParentDepth(rows(t.chapters), 'parentId')) {
      const { data } = takeRow(src, m.chapter);
      data.projectId = project.id;
      data.parentId = ref(m.chapter, src.parentId);
      data.eventId = ref(m.event, src.eventId);
      data.locationId = ref(m.location, src.locationId);
      await tx.chapter.create({ data: data as never });
      counts.chapters = (counts.chapters ?? 0) + 1;
    }
    for (const src of rows(t.chapterRevisions)) {
      const { data } = takeRow(src, new Map());
      data.chapterId = ref(m.chapter, src.chapterId) ?? '';
      if (data.chapterId) {
        await tx.chapterRevision.create({ data: data as never });
        counts.chapterRevisions = (counts.chapterRevisions ?? 0) + 1;
      }
    }

    // Карта
    for (const src of rows(t.mapElements)) {
      const { data } = takeRow(src, new Map());
      data.projectId = project.id;
      data.locationId = ref(m.location, src.locationId);
      await tx.mapElement.create({ data: data as never });
      counts.mapElements = (counts.mapElements ?? 0) + 1;
    }
    for (const src of rows(t.mapDrawings)) {
      const { data } = takeRow(src, new Map());
      data.projectId = project.id;
      await tx.mapDrawing.create({ data: data as never });
      counts.mapDrawings = (counts.mapDrawings ?? 0) + 1;
    }

    // Вики
    for (const src of rows(t.wikiPages)) {
      const { data } = takeRow(src, new Map());
      data.projectId = project.id;
      await tx.wikiPage.create({ data: data as never });
      counts.wikiPages = (counts.wikiPages ?? 0) + 1;
    }

    // Снимки мира
    for (const src of rows(t.snapshots)) {
      const { data } = takeRow(src, new Map());
      data.projectId = project.id;
      data.eventId = ref(m.event, src.eventId);
      await tx.worldSnapshot.create({ data: data as never });
      counts.snapshots = (counts.snapshots ?? 0) + 1;
    }

    // Экономика
    for (const src of rows(t.currencies)) {
      const { data } = takeRow(src, m.currency);
      data.projectId = project.id;
      await tx.currency.create({ data: data as never });
      counts.currencies = (counts.currencies ?? 0) + 1;
    }
    for (const src of rows(t.resources)) {
      const { data } = takeRow(src, new Map());
      data.projectId = project.id;
      data.currencyId = ref(m.currency, src.currencyId);
      await tx.resource.create({ data: data as never });
      counts.resources = (counts.resources ?? 0) + 1;
    }
    for (const src of rows(t.tradeRoutes)) {
      const { data } = takeRow(src, new Map());
      data.projectId = project.id;
      data.fromLocationId = ref(m.location, src.fromLocationId);
      data.toLocationId = ref(m.location, src.toLocationId);
      await tx.tradeRoute.create({ data: data as never });
      counts.tradeRoutes = (counts.tradeRoutes ?? 0) + 1;
    }

    // Знания персонажей
    for (const src of rows(t.knowledgeEntries)) {
      const { data } = takeRow(src, new Map());
      data.projectId = project.id;
      data.characterId = ref(m.character, src.characterId) ?? '';
      data.eventId = ref(m.event, src.eventId);
      if (data.characterId) {
        await tx.knowledgeEntry.create({ data: data as never });
        counts.knowledgeEntries = (counts.knowledgeEntries ?? 0) + 1;
      }
    }

    // Календари, наследование черт, доска расследований
    for (const src of rows(t.calendars)) {
      const { data } = takeRow(src, new Map());
      data.projectId = project.id;
      await tx.calendar.create({ data: data as never });
      counts.calendars = (counts.calendars ?? 0) + 1;
    }
    for (const src of rows(t.traits)) {
      const { data } = takeRow(src, new Map());
      data.projectId = project.id;
      await tx.traitInheritance.create({ data: data as never });
      counts.traits = (counts.traits ?? 0) + 1;
    }
    for (const src of rows(t.investigationPins)) {
      const { data } = takeRow(src, m.pin);
      data.projectId = project.id;
      const em = entityTypeMap(src.entityType);
      data.entityId = em ? ref(em, src.entityId) : null;
      await tx.investigationPin.create({ data: data as never });
      counts.investigationPins = (counts.investigationPins ?? 0) + 1;
    }
    for (const src of rows(t.investigationThreads)) {
      const { data } = takeRow(src, new Map());
      data.projectId = project.id;
      data.fromPinId = ref(m.pin, src.fromPinId) ?? '';
      data.toPinId = ref(m.pin, src.toPinId) ?? '';
      if (data.fromPinId && data.toPinId) {
        await tx.investigationThread.create({ data: data as never });
        counts.investigationThreads = (counts.investigationThreads ?? 0) + 1;
      }
    }

    return project;
    },
    // Полный перенос — тысячи вставок: дефолтных 5с мало
    { timeout: 300_000, maxWait: 30_000 }
  );

  return { projectId: created.id, counts };
}
