ALTER TABLE "blog_posts" ADD COLUMN "topic" TEXT NOT NULL DEFAULT '';
ALTER TABLE "blog_posts" ADD COLUMN "tags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "blog_posts" ADD COLUMN "views" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "blog_posts" ADD COLUMN "levelId" TEXT;

CREATE TABLE "author_levels" (
    "id" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "priceRub" INTEGER NOT NULL,
    "avatar" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "author_levels_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "author_levels_authorId_idx" ON "author_levels"("authorId");
ALTER TABLE "author_levels" ADD CONSTRAINT "author_levels_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "blog_posts" ADD CONSTRAINT "blog_posts_levelId_fkey" FOREIGN KEY ("levelId") REFERENCES "author_levels"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "author_follows" (
    "userId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "author_follows_pkey" PRIMARY KEY ("userId","authorId")
);
CREATE INDEX "author_follows_authorId_idx" ON "author_follows"("authorId");
ALTER TABLE "author_follows" ADD CONSTRAINT "author_follows_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "author_follows" ADD CONSTRAINT "author_follows_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "author_subscriptions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "levelId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "author_subscriptions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "author_subscriptions_userId_authorId_key" ON "author_subscriptions"("userId", "authorId");
CREATE INDEX "author_subscriptions_authorId_idx" ON "author_subscriptions"("authorId");
ALTER TABLE "author_subscriptions" ADD CONSTRAINT "author_subscriptions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "author_subscriptions" ADD CONSTRAINT "author_subscriptions_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "author_subscriptions" ADD CONSTRAINT "author_subscriptions_levelId_fkey" FOREIGN KEY ("levelId") REFERENCES "author_levels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "blog_comments" (
    "id" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "authorName" TEXT NOT NULL DEFAULT '',
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "blog_comments_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "blog_comments_postId_createdAt_idx" ON "blog_comments"("postId", "createdAt");
ALTER TABLE "blog_comments" ADD CONSTRAINT "blog_comments_postId_fkey" FOREIGN KEY ("postId") REFERENCES "blog_posts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "blog_comments" ADD CONSTRAINT "blog_comments_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "blog_likes" (
    "userId" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "blog_likes_pkey" PRIMARY KEY ("userId","postId")
);
CREATE INDEX "blog_likes_postId_idx" ON "blog_likes"("postId");
ALTER TABLE "blog_likes" ADD CONSTRAINT "blog_likes_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "blog_likes" ADD CONSTRAINT "blog_likes_postId_fkey" FOREIGN KEY ("postId") REFERENCES "blog_posts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "blog_reports" (
    "id" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "note" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "blog_reports_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "blog_reports_postId_idx" ON "blog_reports"("postId");
ALTER TABLE "blog_reports" ADD CONSTRAINT "blog_reports_postId_fkey" FOREIGN KEY ("postId") REFERENCES "blog_posts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "blog_reports" ADD CONSTRAINT "blog_reports_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "blog_donations" (
    "id" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "amountRub" INTEGER NOT NULL,
    "note" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "blog_donations_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "blog_donations_postId_idx" ON "blog_donations"("postId");
ALTER TABLE "blog_donations" ADD CONSTRAINT "blog_donations_postId_fkey" FOREIGN KEY ("postId") REFERENCES "blog_posts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "blog_donations" ADD CONSTRAINT "blog_donations_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
