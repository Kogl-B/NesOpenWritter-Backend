BEGIN;

ALTER TABLE "blog_likes" ADD COLUMN "emoji" TEXT NOT NULL DEFAULT 'heart',
    ADD CONSTRAINT "blog_likes_emoji_check" CHECK ("emoji" IN ('like', 'heart', 'fire', 'clap', 'smile', 'book'));

CREATE TABLE "blog_comment_files" (
    "commentId" TEXT PRIMARY KEY,
    "name" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "data" BYTEA NOT NULL,
    CONSTRAINT "blog_comment_files_size_check" CHECK ("size" BETWEEN 0 AND 5242880 AND "size" = octet_length("data")),
    CONSTRAINT "blog_comment_files_commentId_fkey" FOREIGN KEY ("commentId") REFERENCES "blog_comments"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

ALTER TABLE "blog_reports" ADD COLUMN "postTitle" TEXT NOT NULL DEFAULT '',
    ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'complaint',
    ADD COLUMN "status" TEXT NOT NULL DEFAULT 'new',
    ADD CONSTRAINT "blog_reports_kind_check" CHECK ("kind" IN ('complaint', 'suggestion')),
    ADD CONSTRAINT "blog_reports_status_check" CHECK ("status" IN ('new', 'reviewed', 'resolved'));

UPDATE "blog_reports" AS report SET "postTitle" = post."title"
FROM "blog_posts" AS post WHERE report."postId" = post."id";

ALTER TABLE "blog_reports" ALTER COLUMN "postId" DROP NOT NULL;
ALTER TABLE "blog_reports" DROP CONSTRAINT "blog_reports_postId_fkey";
ALTER TABLE "blog_reports" ADD CONSTRAINT "blog_reports_postId_fkey" FOREIGN KEY ("postId") REFERENCES "blog_posts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "blog_reports_createdAt_id_idx" ON "blog_reports"("createdAt", "id");
CREATE INDEX "blog_reports_kind_status_createdAt_idx" ON "blog_reports"("kind", "status", "createdAt");

COMMIT;
