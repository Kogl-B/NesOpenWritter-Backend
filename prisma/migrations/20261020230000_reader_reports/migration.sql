CREATE TABLE "reader_reports" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "chapterId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "quote" TEXT NOT NULL,
    "note" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reader_reports_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "reader_reports_authorId_createdAt_idx" ON "reader_reports"("authorId", "createdAt");
