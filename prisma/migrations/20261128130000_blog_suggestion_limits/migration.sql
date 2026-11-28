BEGIN;
SET LOCAL lock_timeout = '5s';
CREATE TABLE "blog_suggestion_limits" (
  "readerId" TEXT NOT NULL REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "authorId" TEXT NOT NULL REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "blockedUntil" TIMESTAMP(3),
  "requestedAt" TIMESTAMP(3),
  "resetAt" TIMESTAMP(3),
  CONSTRAINT "blog_suggestion_limits_pkey" PRIMARY KEY ("readerId", "authorId")
);

CREATE INDEX "blog_suggestion_limits_authorId_blockedUntil_idx"
ON "blog_suggestion_limits"("authorId", "blockedUntil");

CREATE INDEX "blog_reports_userId_kind_createdAt_idx"
ON "blog_reports"("userId", "kind", "createdAt");

COMMIT;
