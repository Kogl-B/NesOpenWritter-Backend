-- Длина текста и лёгкая статистика: суточные счётчики, прогресс чтения, встроенная реклама.
ALTER TABLE "chapters" ADD COLUMN IF NOT EXISTS "charCount" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS "daily_metrics" (
  "day" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "bucket" TEXT NOT NULL,
  "total" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "daily_metrics_pkey" PRIMARY KEY ("day", "kind", "bucket")
);

CREATE TABLE IF NOT EXISTS "read_progress" (
  "userId" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "chapterId" TEXT NOT NULL,
  "percent" INTEGER NOT NULL DEFAULT 0,
  "charsSeen" INTEGER NOT NULL DEFAULT 0,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "read_progress_pkey" PRIMARY KEY ("userId", "chapterId")
);

CREATE INDEX IF NOT EXISTS "read_progress_projectId_idx" ON "read_progress"("projectId");
CREATE INDEX IF NOT EXISTS "read_progress_userId_updatedAt_idx" ON "read_progress"("userId", "updatedAt");

ALTER TABLE "read_progress" DROP CONSTRAINT IF EXISTS "read_progress_userId_fkey";
ALTER TABLE "read_progress" ADD CONSTRAINT "read_progress_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "read_progress" DROP CONSTRAINT IF EXISTS "read_progress_chapterId_fkey";
ALTER TABLE "read_progress" ADD CONSTRAINT "read_progress_chapterId_fkey"
  FOREIGN KEY ("chapterId") REFERENCES "chapters"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "house_ads" (
  "id" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "href" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "audience" TEXT NOT NULL DEFAULT 'free',
  "sort" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "house_ads_pkey" PRIMARY KEY ("id")
);

INSERT INTO "house_ads" ("id", "title", "body", "href", "enabled", "audience", "sort")
VALUES
  (
    'site-banner',
    'Пишите без этой строки',
    'На бесплатном тарифе «Тест» и у гостей здесь короткая заметка. «Хобби» и выше убирают её и дают больше проектов.',
    '/account',
    true,
    'free',
    0
  ),
  (
    'reader-note',
    'Чтение без заметок',
    'Этот блок виден гостям и бесплатному тарифу. Платный тариф прячет его на всём сайте.',
    '/account',
    true,
    'free',
    1
  ),
  (
    'projects-banner',
    'Больше книг — на платном тарифе',
    '«Тест» хранит 3 проекта. Следующие тарифы расширяют место и убирают встроенную рекламу.',
    '/account',
    true,
    'free',
    2
  )
ON CONFLICT ("id") DO NOTHING;
