CREATE TABLE "advertising_settings" (
  "id" TEXT PRIMARY KEY, "publisherId" TEXT NOT NULL DEFAULT '', "cookiebotId" TEXT NOT NULL DEFAULT '',
  "siteUnit" TEXT NOT NULL DEFAULT '', "readerUnit" TEXT NOT NULL DEFAULT '',
  "enabled" BOOLEAN NOT NULL DEFAULT false, "autoSync" BOOLEAN NOT NULL DEFAULT false, "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE TABLE "sponsored_posts" (
  "id" TEXT PRIMARY KEY, "title" TEXT NOT NULL, "summary" TEXT NOT NULL, "body" TEXT NOT NULL,
  "advertiser" TEXT NOT NULL, "registrationId" TEXT NOT NULL DEFAULT '', "imageUrl" TEXT NOT NULL DEFAULT '', "href" TEXT NOT NULL DEFAULT '', "placement" TEXT NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'draft', "priceMinor" INTEGER NOT NULL DEFAULT 0, "currency" TEXT NOT NULL DEFAULT 'RUB',
  "paidAt" TIMESTAMP(3), "startsAt" TIMESTAMP(3) NOT NULL, "endsAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "sponsored_post_valid_period" CHECK ("startsAt" < "endsAt"),
  CONSTRAINT "sponsored_post_valid_price" CHECK ("priceMinor" >= 0),
  CONSTRAINT "sponsored_post_valid_state" CHECK ("state" IN ('draft','active','paused','archived'))
);
CREATE INDEX "sponsored_posts_placement_state_startsAt_idx" ON "sponsored_posts"("placement","state","startsAt");
CREATE TABLE "ad_exposures" (
  "id" TEXT PRIMARY KEY, "day" TEXT NOT NULL, "placement" TEXT NOT NULL, "postId" TEXT NOT NULL,
  "viewable" BOOLEAN NOT NULL DEFAULT false, "clicked" BOOLEAN NOT NULL DEFAULT false,
  CONSTRAINT "ad_exposures_postId_fkey" FOREIGN KEY ("postId") REFERENCES "sponsored_posts"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "ad_exposures_day_postId_placement_idx" ON "ad_exposures"("day","postId","placement");
CREATE TABLE "adsense_days" (
  "publisherId" TEXT NOT NULL, "day" TEXT NOT NULL, "unit" TEXT NOT NULL,
  "requests" BIGINT NOT NULL, "matched" BIGINT NOT NULL, "impressions" BIGINT NOT NULL,
  "clicks" BIGINT NOT NULL, "earnings" DECIMAL(21,6) NOT NULL, "measurability" DECIMAL(10,9), "viewability" DECIMAL(10,9), "currency" TEXT NOT NULL,
  PRIMARY KEY ("publisherId","day","unit")
);
CREATE TABLE "adsense_sync" (
  "publisherId" TEXT PRIMARY KEY, "from" TEXT NOT NULL, "to" TEXT NOT NULL, "syncedAt" TIMESTAMP(3) NOT NULL
);
