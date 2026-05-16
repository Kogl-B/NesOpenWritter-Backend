-- CreateTable
CREATE TABLE "character_relations" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "fromCharacterId" TEXT NOT NULL,
    "toCharacterId" TEXT NOT NULL,
    "relationType" TEXT NOT NULL,
    "strength" INTEGER NOT NULL DEFAULT 50,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "character_relations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "genealogy_edges" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "parentId" TEXT NOT NULL,
    "childId" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'biological',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "genealogy_edges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "items" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "shortName" TEXT,
    "imagePath" TEXT,
    "category" TEXT NOT NULL DEFAULT 'other',
    "rarity" TEXT NOT NULL DEFAULT 'common',
    "summary" TEXT,
    "description" TEXT,
    "properties" JSONB NOT NULL DEFAULT '{}',
    "currentOwnerId" TEXT,
    "currentLocationId" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "item_timeline_points" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "at" TEXT NOT NULL,
    "ownerId" TEXT,
    "locationId" TEXT,
    "eventId" TEXT,
    "note" TEXT,
    "orderIndex" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "item_timeline_points_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "locations" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "shortName" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'place',
    "parentLocationId" TEXT,
    "lodLevel" INTEGER NOT NULL DEFAULT 0,
    "coordX" DOUBLE PRECISION,
    "coordY" DOUBLE PRECISION,
    "description" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "locations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "timeline_events" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "summary" TEXT,
    "description" TEXT,
    "at" TEXT NOT NULL,
    "atNumeric" DOUBLE PRECISION,
    "durationNumeric" DOUBLE PRECISION,
    "locationId" TEXT,
    "color" TEXT,
    "icon" TEXT,
    "importance" INTEGER NOT NULL DEFAULT 3,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "timeline_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "event_characters" (
    "eventId" TEXT NOT NULL,
    "characterId" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'participant',
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "event_characters_pkey" PRIMARY KEY ("eventId","characterId")
);

-- CreateTable
CREATE TABLE "event_items" (
    "eventId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "event_items_pkey" PRIMARY KEY ("eventId","itemId")
);

-- CreateTable
CREATE TABLE "character_positions" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "characterId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "locationId" TEXT,
    "coordX" DOUBLE PRECISION,
    "coordY" DOUBLE PRECISION,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "character_positions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chapters" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "parentId" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'chapter',
    "title" TEXT NOT NULL,
    "summary" TEXT,
    "content" JSONB NOT NULL DEFAULT '{}',
    "orderIndex" INTEGER NOT NULL DEFAULT 0,
    "wordCount" INTEGER NOT NULL DEFAULT 0,
    "eventId" TEXT,
    "locationId" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "chapters_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tags" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT NOT NULL DEFAULT '#888888',
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "entity_tags" (
    "tagId" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "entity_tags_pkey" PRIMARY KEY ("tagId","entityType","entityId")
);

-- CreateIndex
CREATE INDEX "character_relations_projectId_idx" ON "character_relations"("projectId");

-- CreateIndex
CREATE INDEX "character_relations_fromCharacterId_idx" ON "character_relations"("fromCharacterId");

-- CreateIndex
CREATE INDEX "character_relations_toCharacterId_idx" ON "character_relations"("toCharacterId");

-- CreateIndex
CREATE UNIQUE INDEX "character_relations_fromCharacterId_toCharacterId_relationT_key" ON "character_relations"("fromCharacterId", "toCharacterId", "relationType");

-- CreateIndex
CREATE INDEX "genealogy_edges_projectId_idx" ON "genealogy_edges"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "genealogy_edges_parentId_childId_kind_key" ON "genealogy_edges"("parentId", "childId", "kind");

-- CreateIndex
CREATE INDEX "items_projectId_idx" ON "items"("projectId");

-- CreateIndex
CREATE INDEX "items_currentOwnerId_idx" ON "items"("currentOwnerId");

-- CreateIndex
CREATE INDEX "items_currentLocationId_idx" ON "items"("currentLocationId");

-- CreateIndex
CREATE INDEX "item_timeline_points_projectId_idx" ON "item_timeline_points"("projectId");

-- CreateIndex
CREATE INDEX "item_timeline_points_itemId_idx" ON "item_timeline_points"("itemId");

-- CreateIndex
CREATE INDEX "locations_projectId_idx" ON "locations"("projectId");

-- CreateIndex
CREATE INDEX "locations_parentLocationId_idx" ON "locations"("parentLocationId");

-- CreateIndex
CREATE INDEX "timeline_events_projectId_idx" ON "timeline_events"("projectId");

-- CreateIndex
CREATE INDEX "timeline_events_locationId_idx" ON "timeline_events"("locationId");

-- CreateIndex
CREATE INDEX "event_characters_characterId_idx" ON "event_characters"("characterId");

-- CreateIndex
CREATE INDEX "event_items_itemId_idx" ON "event_items"("itemId");

-- CreateIndex
CREATE INDEX "character_positions_projectId_idx" ON "character_positions"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "character_positions_characterId_eventId_key" ON "character_positions"("characterId", "eventId");

-- CreateIndex
CREATE INDEX "chapters_projectId_idx" ON "chapters"("projectId");

-- CreateIndex
CREATE INDEX "chapters_parentId_idx" ON "chapters"("parentId");

-- CreateIndex
CREATE INDEX "tags_projectId_idx" ON "tags"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "tags_projectId_name_key" ON "tags"("projectId", "name");

-- CreateIndex
CREATE INDEX "entity_tags_entityType_entityId_idx" ON "entity_tags"("entityType", "entityId");

-- AddForeignKey
ALTER TABLE "character_relations" ADD CONSTRAINT "character_relations_fromCharacterId_fkey" FOREIGN KEY ("fromCharacterId") REFERENCES "characters"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "character_relations" ADD CONSTRAINT "character_relations_toCharacterId_fkey" FOREIGN KEY ("toCharacterId") REFERENCES "characters"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "genealogy_edges" ADD CONSTRAINT "genealogy_edges_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "characters"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "genealogy_edges" ADD CONSTRAINT "genealogy_edges_childId_fkey" FOREIGN KEY ("childId") REFERENCES "characters"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "items" ADD CONSTRAINT "items_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "items" ADD CONSTRAINT "items_currentOwnerId_fkey" FOREIGN KEY ("currentOwnerId") REFERENCES "characters"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "items" ADD CONSTRAINT "items_currentLocationId_fkey" FOREIGN KEY ("currentLocationId") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "item_timeline_points" ADD CONSTRAINT "item_timeline_points_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "locations" ADD CONSTRAINT "locations_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "locations" ADD CONSTRAINT "locations_parentLocationId_fkey" FOREIGN KEY ("parentLocationId") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "timeline_events" ADD CONSTRAINT "timeline_events_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "timeline_events" ADD CONSTRAINT "timeline_events_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_characters" ADD CONSTRAINT "event_characters_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "timeline_events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_characters" ADD CONSTRAINT "event_characters_characterId_fkey" FOREIGN KEY ("characterId") REFERENCES "characters"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_items" ADD CONSTRAINT "event_items_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "timeline_events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_items" ADD CONSTRAINT "event_items_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "character_positions" ADD CONSTRAINT "character_positions_characterId_fkey" FOREIGN KEY ("characterId") REFERENCES "characters"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "character_positions" ADD CONSTRAINT "character_positions_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "timeline_events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "character_positions" ADD CONSTRAINT "character_positions_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chapters" ADD CONSTRAINT "chapters_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chapters" ADD CONSTRAINT "chapters_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "chapters"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chapters" ADD CONSTRAINT "chapters_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "timeline_events"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tags" ADD CONSTRAINT "tags_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entity_tags" ADD CONSTRAINT "entity_tags_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "tags"("id") ON DELETE CASCADE ON UPDATE CASCADE;
