CREATE TABLE "book_subscriptions" (
    "userId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "book_subscriptions_pkey" PRIMARY KEY ("userId","projectId")
);

CREATE INDEX "book_subscriptions_projectId_createdAt_idx" ON "book_subscriptions"("projectId", "createdAt");

ALTER TABLE "book_subscriptions" ADD CONSTRAINT "book_subscriptions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "book_subscriptions" ADD CONSTRAINT "book_subscriptions_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
