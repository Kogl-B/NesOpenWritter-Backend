BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE "two_factors"
  ADD COLUMN "failedVerificationCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "lockedUntil" TIMESTAMP(3);
COMMIT;
