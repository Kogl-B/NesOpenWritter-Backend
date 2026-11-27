BEGIN;

ALTER TABLE "blog_comment_files" ADD COLUMN "id" TEXT,
    ADD COLUMN "position" INTEGER NOT NULL DEFAULT 0;

UPDATE "blog_comment_files" SET "id" = "commentId";
ALTER TABLE "blog_comment_files" ALTER COLUMN "id" SET NOT NULL;
ALTER TABLE "blog_comment_files" DROP CONSTRAINT "blog_comment_files_pkey";
ALTER TABLE "blog_comment_files" ADD CONSTRAINT "blog_comment_files_pkey" PRIMARY KEY ("id");
ALTER TABLE "blog_comment_files" ADD CONSTRAINT "blog_comment_files_position_check" CHECK ("position" BETWEEN 0 AND 2);
CREATE UNIQUE INDEX "blog_comment_files_commentId_position_key" ON "blog_comment_files"("commentId", "position");

COMMIT;
