-- DropIndex
DROP INDEX "characters_bio_trgm";

-- DropIndex
DROP INDEX "characters_name_trgm";

-- DropIndex
DROP INDEX "characters_short_trgm";

-- DropIndex
DROP INDEX "characters_summary_trgm";

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "plan" TEXT;
