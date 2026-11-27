ALTER TABLE "blog_posts" ADD COLUMN "publishedAt" TIMESTAMP(3);
UPDATE "blog_posts" SET "publishedAt" = "createdAt" WHERE "published";
CREATE INDEX "blog_posts_published_publishedAt_idx" ON "blog_posts"("published", "publishedAt");

ALTER TABLE "author_levels" ADD COLUMN "available" BOOLEAN NOT NULL DEFAULT true;

CREATE TABLE "blog_profiles" (
    "authorId" TEXT NOT NULL,
    "nickname" TEXT,
    "title" TEXT NOT NULL DEFAULT '',
    "description" TEXT NOT NULL DEFAULT '',
    "defaultAudience" TEXT NOT NULL DEFAULT 'all',
    "defaultCommentAccess" TEXT NOT NULL DEFAULT 'all',
    CONSTRAINT "blog_profiles_pkey" PRIMARY KEY ("authorId"),
    CONSTRAINT "blog_profiles_authorId_fkey" FOREIGN KEY ("authorId")
        REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "blog_profiles_nickname_key" ON "blog_profiles"("nickname");
