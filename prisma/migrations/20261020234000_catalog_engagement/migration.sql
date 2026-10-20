CREATE TABLE "book_reactions" (
    "userId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "liked" BOOLEAN NOT NULL DEFAULT false,
    "favorite" BOOLEAN NOT NULL DEFAULT false,
    "lastReadAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "book_reactions_pkey" PRIMARY KEY ("userId","projectId")
);

CREATE INDEX "book_reactions_projectId_liked_idx" ON "book_reactions"("projectId", "liked");
CREATE INDEX "book_reactions_projectId_lastReadAt_idx" ON "book_reactions"("projectId", "lastReadAt");

CREATE TABLE "book_views" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "book_views_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "book_views_projectId_createdAt_idx" ON "book_views"("projectId", "createdAt");

CREATE TABLE "book_comments" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "authorName" TEXT NOT NULL DEFAULT '',
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "book_comments_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "book_comments_projectId_createdAt_idx" ON "book_comments"("projectId", "createdAt");
