BEGIN;
SET LOCAL lock_timeout = '5s';
-- Existing project ids remain the ids of their first books.
ALTER TABLE "projects" ADD COLUMN "universeId" TEXT, ADD COLUMN "universeName" TEXT;
ALTER TABLE "projects" ADD CONSTRAINT "projects_universeId_fkey"
    FOREIGN KEY ("universeId") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "projects" ADD CONSTRAINT "projects_not_self_universe"
    CHECK ("universeId" IS NULL OR "universeId" <> "id");
CREATE INDEX "projects_universeId_idx" ON "projects"("universeId");
COMMIT;
