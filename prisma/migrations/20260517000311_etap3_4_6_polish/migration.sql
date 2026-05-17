-- AlterTable
ALTER TABLE "users" ADD COLUMN     "settings" JSONB NOT NULL DEFAULT '{}';

-- CreateTable
CREATE TABLE "map_elements" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "kind" TEXT NOT NULL,
    "subkind" TEXT,
    "locationId" TEXT,
    "geometry" JSONB NOT NULL DEFAULT '{}',
    "style" JSONB NOT NULL DEFAULT '{}',
    "lodMin" INTEGER NOT NULL DEFAULT 0,
    "lodMax" INTEGER NOT NULL DEFAULT 4,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "map_elements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "map_drawings" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "layer" TEXT NOT NULL DEFAULT 'default',
    "payload" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "map_drawings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chapter_revisions" (
    "id" TEXT NOT NULL,
    "chapterId" TEXT NOT NULL,
    "label" TEXT,
    "content" JSONB NOT NULL DEFAULT '{}',
    "wordCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chapter_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scene_mentions" (
    "sceneId" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "scene_mentions_pkey" PRIMARY KEY ("sceneId","entityType","entityId")
);

-- CreateIndex
CREATE INDEX "map_elements_projectId_idx" ON "map_elements"("projectId");

-- CreateIndex
CREATE INDEX "map_elements_locationId_idx" ON "map_elements"("locationId");

-- CreateIndex
CREATE INDEX "map_drawings_projectId_idx" ON "map_drawings"("projectId");

-- CreateIndex
CREATE INDEX "chapter_revisions_chapterId_idx" ON "chapter_revisions"("chapterId");

-- CreateIndex
CREATE INDEX "scene_mentions_entityType_entityId_idx" ON "scene_mentions"("entityType", "entityId");

-- AddForeignKey
ALTER TABLE "map_elements" ADD CONSTRAINT "map_elements_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "map_elements" ADD CONSTRAINT "map_elements_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "map_drawings" ADD CONSTRAINT "map_drawings_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chapter_revisions" ADD CONSTRAINT "chapter_revisions_chapterId_fkey" FOREIGN KEY ("chapterId") REFERENCES "chapters"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scene_mentions" ADD CONSTRAINT "scene_mentions_sceneId_fkey" FOREIGN KEY ("sceneId") REFERENCES "chapters"("id") ON DELETE CASCADE ON UPDATE CASCADE;
