CREATE TABLE "daily_browser_visits" (
  "day" TEXT NOT NULL,
  "browserHash" BYTEA NOT NULL,
  CONSTRAINT "daily_browser_visits_pkey" PRIMARY KEY ("day", "browserHash")
);
