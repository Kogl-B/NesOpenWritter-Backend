-- Статус главы, срок запланированной публикации и теги для площадок.
ALTER TABLE "chapters" ADD COLUMN "stage" TEXT NOT NULL DEFAULT 'new';
ALTER TABLE "chapters" ADD COLUMN "publishAt" TIMESTAMP(3);
ALTER TABLE "chapters" ADD COLUMN "tags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

CREATE INDEX "chapters_stage_publishAt_idx" ON "chapters"("stage", "publishAt");
