CREATE TABLE "reading_positions" (
  "userId" TEXT NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "projectId" TEXT NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "chapterId" TEXT NOT NULL REFERENCES "chapters"("id") ON DELETE CASCADE,
  "version" TEXT NOT NULL,
  "block" INTEGER,
  "offset" INTEGER NOT NULL,
  "fraction" INTEGER NOT NULL,
  "observedAt" TIMESTAMP(3) NOT NULL,
  PRIMARY KEY ("userId", "projectId"),
  CHECK ("block" IS NULL OR "block" >= 0),
  CHECK ("offset" BETWEEN 0 AND 10000),
  CHECK ("fraction" BETWEEN 0 AND 10000)
);
CREATE INDEX "reading_positions_userId_observedAt_idx" ON "reading_positions"("userId", "observedAt" DESC);
CREATE INDEX "reading_positions_chapterId_idx" ON "reading_positions"("chapterId");
CREATE INDEX "reading_positions_projectId_idx" ON "reading_positions"("projectId");
