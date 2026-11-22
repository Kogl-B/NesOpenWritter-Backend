-- Подключения площадок, журнал выпуска главы и уведомления подписчикам книги.
CREATE TABLE "publish_accounts" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "label" TEXT NOT NULL DEFAULT '',
    "secretCipher" TEXT NOT NULL DEFAULT '',
    "secretHint" TEXT NOT NULL DEFAULT '',
    "meta" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "publish_accounts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "publish_accounts_userId_platform_key" ON "publish_accounts"("userId", "platform");
CREATE INDEX "publish_accounts_userId_idx" ON "publish_accounts"("userId");

ALTER TABLE "publish_accounts" ADD CONSTRAINT "publish_accounts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "publish_deliveries" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "chapterId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "remoteId" TEXT NOT NULL DEFAULT '',
    "remoteUrl" TEXT NOT NULL DEFAULT '',
    "error" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "publish_deliveries_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "publish_deliveries_userId_createdAt_idx" ON "publish_deliveries"("userId", "createdAt");
CREATE INDEX "publish_deliveries_chapterId_createdAt_idx" ON "publish_deliveries"("chapterId", "createdAt");

ALTER TABLE "publish_deliveries" ADD CONSTRAINT "publish_deliveries_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "publish_deliveries" ADD CONSTRAINT "publish_deliveries_chapterId_fkey" FOREIGN KEY ("chapterId") REFERENCES "chapters"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "reader_notices" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "chapterId" TEXT NOT NULL,
    "bookTitle" TEXT NOT NULL,
    "chapterTitle" TEXT NOT NULL,
    "href" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reader_notices_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "reader_notices_userId_chapterId_key" ON "reader_notices"("userId", "chapterId");
CREATE INDEX "reader_notices_userId_createdAt_idx" ON "reader_notices"("userId", "createdAt");

ALTER TABLE "reader_notices" ADD CONSTRAINT "reader_notices_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "reader_notices" ADD CONSTRAINT "reader_notices_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "reader_notices" ADD CONSTRAINT "reader_notices_chapterId_fkey" FOREIGN KEY ("chapterId") REFERENCES "chapters"("id") ON DELETE CASCADE ON UPDATE CASCADE;
