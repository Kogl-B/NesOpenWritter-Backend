ALTER TABLE "blog_posts" ADD COLUMN "audience" TEXT NOT NULL DEFAULT 'all';
ALTER TABLE "blog_posts" ADD COLUMN "commentAccess" TEXT NOT NULL DEFAULT 'all';

CREATE TABLE "blog_moderators" (
    "postId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "blog_moderators_pkey" PRIMARY KEY ("postId","userId")
);

CREATE INDEX "blog_moderators_userId_idx" ON "blog_moderators"("userId");

ALTER TABLE "blog_moderators" ADD CONSTRAINT "blog_moderators_postId_fkey" FOREIGN KEY ("postId") REFERENCES "blog_posts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "blog_moderators" ADD CONSTRAINT "blog_moderators_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
