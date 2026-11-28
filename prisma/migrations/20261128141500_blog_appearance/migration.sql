BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE "blog_profiles" ADD COLUMN "appearance" JSONB NOT NULL DEFAULT '{}';

COMMIT;
