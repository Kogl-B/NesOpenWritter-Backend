ALTER TABLE "ai_jobs"
  ADD COLUMN "timelineChapterId" TEXT,
  ADD COLUMN "timelineKey" TEXT;

CREATE UNIQUE INDEX "ai_jobs_timelineKey_key" ON "ai_jobs"("timelineKey");
CREATE INDEX "ai_jobs_timelineChapterId_createdAt_idx" ON "ai_jobs"("timelineChapterId", "createdAt");

ALTER TABLE "ai_jobs"
  ADD CONSTRAINT "ai_jobs_timelineChapterId_fkey"
  FOREIGN KEY ("timelineChapterId") REFERENCES "chapters"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "timeline_reviews" (
  "jobId" TEXT NOT NULL,
  "proposalIndex" INTEGER NOT NULL,
  "eventId" TEXT,
  "disposition" TEXT NOT NULL,
  "quote" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "timeline_reviews_pkey" PRIMARY KEY ("jobId", "proposalIndex"),
  CONSTRAINT "timeline_reviews_jobId_fkey"
    FOREIGN KEY ("jobId") REFERENCES "ai_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "timeline_reviews_eventId_fkey"
    FOREIGN KEY ("eventId") REFERENCES "timeline_events"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "timeline_reviews_eventId_idx" ON "timeline_reviews"("eventId");
