ALTER TABLE "users" ADD COLUMN "walletBalanceCents" BIGINT NOT NULL DEFAULT 0;

UPDATE "users"
SET "walletBalanceCents" = LEAST(9007199254740991, GREATEST(0, ROUND(("settings" #>> '{wallet,balance}')::numeric * 100)))::bigint
WHERE jsonb_typeof("settings" #> '{wallet,balance}') = 'number';

ALTER TABLE "users" ADD CONSTRAINT "users_wallet_balance_range"
CHECK ("walletBalanceCents" BETWEEN 0 AND 9007199254740991);

CREATE TABLE "blog_post_readers" (
    "postId" TEXT NOT NULL REFERENCES "blog_posts"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    "readerKey" TEXT NOT NULL,
    "subscriberViews" INTEGER NOT NULL DEFAULT 0,
    "otherViews" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "blog_post_readers_pkey" PRIMARY KEY ("postId", "readerKey")
);

CREATE TABLE "blog_wallet_donations" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "senderId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "postTitle" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL CHECK ("amountCents" > 0),
    "note" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "blog_wallet_donations_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "blog_wallet_donations_distinct_accounts" CHECK ("authorId" <> "senderId")
);

CREATE INDEX "blog_wallet_donations_authorId_idx" ON "blog_wallet_donations"("authorId");
CREATE UNIQUE INDEX "blog_wallet_donations_senderId_requestId_key" ON "blog_wallet_donations"("senderId", "requestId");
