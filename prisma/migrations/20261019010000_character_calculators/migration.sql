-- Калькуляторы персонажей (деньги, шмотки, свои классы) и журнал изменений.
CREATE TABLE IF NOT EXISTS "calculators" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "kind" TEXT NOT NULL DEFAULT 'money',
  "unit" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "calculators_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "calculators_projectId_key_key" ON "calculators"("projectId", "key");
CREATE INDEX IF NOT EXISTS "calculators_projectId_idx" ON "calculators"("projectId");

CREATE TABLE IF NOT EXISTS "character_ledger" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "characterId" TEXT NOT NULL,
  "calculatorId" TEXT NOT NULL,
  "chapterId" TEXT,
  "delta" DOUBLE PRECISION NOT NULL,
  "note" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "character_ledger_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "character_ledger_projectId_idx" ON "character_ledger"("projectId");
CREATE INDEX IF NOT EXISTS "character_ledger_characterId_calculatorId_idx" ON "character_ledger"("characterId", "calculatorId");
CREATE INDEX IF NOT EXISTS "character_ledger_chapterId_idx" ON "character_ledger"("chapterId");

DO $$ BEGIN
  ALTER TABLE "calculators"
    ADD CONSTRAINT "calculators_projectId_fkey"
    FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "character_ledger"
    ADD CONSTRAINT "character_ledger_projectId_fkey"
    FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "character_ledger"
    ADD CONSTRAINT "character_ledger_characterId_fkey"
    FOREIGN KEY ("characterId") REFERENCES "characters"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "character_ledger"
    ADD CONSTRAINT "character_ledger_calculatorId_fkey"
    FOREIGN KEY ("calculatorId") REFERENCES "calculators"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "character_ledger"
    ADD CONSTRAINT "character_ledger_chapterId_fkey"
    FOREIGN KEY ("chapterId") REFERENCES "chapters"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
