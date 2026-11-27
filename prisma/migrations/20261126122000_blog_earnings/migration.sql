BEGIN;

ALTER TABLE "author_subscriptions" ADD COLUMN "expiresAt" TIMESTAMP(3), ADD COLUMN "cancelledAt" TIMESTAMP(3);

CREATE TABLE "blog_audience_events" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "authorId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "requestId" TEXT,
  "levelId" TEXT,
  "levelTitle" TEXT NOT NULL DEFAULT '',
  "priceRub" INTEGER NOT NULL DEFAULT 0,
  "amountCents" INTEGER NOT NULL DEFAULT 0,
  "reason" TEXT NOT NULL DEFAULT '',
  "expiresAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "blog_audience_events_payment" CHECK (
    ("amountCents" = 0 AND "requestId" IS NULL)
    OR ("amountCents" > 0 AND "requestId" IS NOT NULL AND "priceRub" > 0 AND "expiresAt" IS NOT NULL
        AND "kind" IN ('joined','renewed','upgraded') AND "authorId" <> "userId")
  )
);
CREATE UNIQUE INDEX "blog_audience_events_userId_requestId_key" ON "blog_audience_events"("userId", "requestId");
CREATE INDEX "blog_audience_events_authorId_createdAt_idx" ON "blog_audience_events"("authorId", "createdAt");

CREATE TABLE "blog_traffic_days" (
  "authorId" TEXT NOT NULL,
  "day" TEXT NOT NULL,
  "source" TEXT NOT NULL,
  "views" INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY ("authorId", "day", "source")
);
CREATE INDEX "blog_wallet_donations_authorId_createdAt_idx" ON "blog_wallet_donations"("authorId", "createdAt");

COMMIT;
