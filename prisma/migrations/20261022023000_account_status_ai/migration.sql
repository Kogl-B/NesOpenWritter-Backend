-- Статус аккаунта и учёт штатного ИИ DeepSeek.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "accountStatus" TEXT NOT NULL DEFAULT 'test';

CREATE TABLE IF NOT EXISTS "ai_providers" (
  "id" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "label" TEXT NOT NULL,
  "keyCipher" TEXT NOT NULL DEFAULT '',
  "keyHint" TEXT NOT NULL DEFAULT '',
  "baseUrl" TEXT NOT NULL DEFAULT 'https://api.deepseek.com',
  "model" TEXT NOT NULL DEFAULT 'deepseek-flash',
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "inputMissUsdPerM" INTEGER NOT NULL DEFAULT 150000,
  "inputHitUsdPerM" INTEGER NOT NULL DEFAULT 3000,
  "outputUsdPerM" INTEGER NOT NULL DEFAULT 600000,
  "peakMultiplier" INTEGER NOT NULL DEFAULT 2,
  "testQuota" INTEGER NOT NULL DEFAULT 30000,
  "regularQuota" INTEGER NOT NULL DEFAULT 300000,
  "adminQuota" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ai_providers_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ai_providers_provider_key" ON "ai_providers"("provider");

CREATE TABLE IF NOT EXISTS "ai_usages" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "projectId" TEXT,
  "provider" TEXT NOT NULL,
  "model" TEXT NOT NULL,
  "purpose" TEXT NOT NULL,
  "promptTokens" INTEGER NOT NULL,
  "completionTokens" INTEGER NOT NULL,
  "cacheHitTokens" INTEGER NOT NULL DEFAULT 0,
  "cacheMissTokens" INTEGER NOT NULL DEFAULT 0,
  "totalTokens" INTEGER NOT NULL,
  "costUsdMicros" INTEGER NOT NULL,
  "peak" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ai_usages_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "ai_usages_userId_createdAt_idx" ON "ai_usages"("userId", "createdAt");
CREATE INDEX IF NOT EXISTS "ai_usages_projectId_createdAt_idx" ON "ai_usages"("projectId", "createdAt");
CREATE INDEX IF NOT EXISTS "ai_usages_createdAt_idx" ON "ai_usages"("createdAt");

DO $$ BEGIN
  ALTER TABLE "ai_usages"
    ADD CONSTRAINT "ai_usages_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
