-- CreateTable
CREATE TABLE "world_snapshots" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "eventId" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "state" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "world_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "world_snapshots_projectId_idx" ON "world_snapshots"("projectId");

-- CreateIndex
CREATE INDEX "world_snapshots_eventId_idx" ON "world_snapshots"("eventId");

-- AddForeignKey
ALTER TABLE "world_snapshots" ADD CONSTRAINT "world_snapshots_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "world_snapshots" ADD CONSTRAINT "world_snapshots_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "timeline_events"("id") ON DELETE SET NULL ON UPDATE CASCADE;
