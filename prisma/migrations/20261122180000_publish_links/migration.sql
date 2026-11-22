-- Связь проекта площадки с книгой на сайте.
CREATE TABLE "publish_links" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "remoteId" TEXT NOT NULL,
    "remoteTitle" TEXT NOT NULL DEFAULT '',
    "remoteUrl" TEXT NOT NULL DEFAULT '',
    "projectId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "publish_links_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "publish_links_userId_platform_remoteId_key" ON "publish_links"("userId", "platform", "remoteId");
CREATE INDEX "publish_links_projectId_idx" ON "publish_links"("projectId");

ALTER TABLE "publish_links" ADD CONSTRAINT "publish_links_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "publish_links" ADD CONSTRAINT "publish_links_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;
