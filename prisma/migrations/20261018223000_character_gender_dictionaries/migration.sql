-- Пол персонажа и словари фракций/способностей пользователя.
ALTER TABLE "characters" ADD COLUMN IF NOT EXISTS "gender" TEXT;

CREATE TABLE IF NOT EXISTS "dictionary_entries" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "projectId" TEXT,
  "kind" TEXT NOT NULL,
  "value" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "dictionary_entries_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "dictionary_entries_userId_kind_idx" ON "dictionary_entries"("userId", "kind");
CREATE INDEX IF NOT EXISTS "dictionary_entries_projectId_idx" ON "dictionary_entries"("projectId");

DO $$ BEGIN
  ALTER TABLE "dictionary_entries"
    ADD CONSTRAINT "dictionary_entries_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "dictionary_entries"
    ADD CONSTRAINT "dictionary_entries_projectId_fkey"
    FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
