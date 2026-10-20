ALTER TABLE "book_reactions" ADD COLUMN "disliked" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "book_reactions" ADD COLUMN "shelf" TEXT NOT NULL DEFAULT '';
ALTER TABLE "book_comments" ADD COLUMN "chapterId" TEXT NOT NULL DEFAULT '';
