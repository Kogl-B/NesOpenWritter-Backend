-- Ограничение публичного материала по стране посетителя.
CREATE TABLE "geo_blocks" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "countries" TEXT[] NOT NULL,
    "note" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "geo_blocks_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "geo_blocks_kind_targetId_key" ON "geo_blocks"("kind", "targetId");
CREATE INDEX "geo_blocks_kind_idx" ON "geo_blocks"("kind");
