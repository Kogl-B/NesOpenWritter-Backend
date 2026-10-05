-- CreateTable
CREATE TABLE "wiki_pages" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "category" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "links" JSONB NOT NULL DEFAULT '[]',
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "wiki_pages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "wiki_pages_projectId_idx" ON "wiki_pages"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "wiki_pages_projectId_slug_key" ON "wiki_pages"("projectId", "slug");

-- AddForeignKey
ALTER TABLE "wiki_pages" ADD CONSTRAINT "wiki_pages_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
