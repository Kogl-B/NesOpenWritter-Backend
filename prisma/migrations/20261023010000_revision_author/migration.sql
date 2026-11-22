-- Кто из аккаунтов сохранил версию сцены. Старые строки остаются без автора.
ALTER TABLE "chapter_revisions" ADD COLUMN "authorId" TEXT;

CREATE INDEX "chapter_revisions_authorId_idx" ON "chapter_revisions"("authorId");

ALTER TABLE "chapter_revisions" ADD CONSTRAINT "chapter_revisions_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
