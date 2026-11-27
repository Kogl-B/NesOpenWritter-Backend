CREATE TABLE "wallet_operations" (
    "userId" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "sourceCents" INTEGER NOT NULL,
    "receivedCents" INTEGER NOT NULL,
    "rateUnits" INTEGER,
    "plan" TEXT,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "wallet_operations_pkey" PRIMARY KEY ("userId", "requestId")
);

CREATE INDEX "wallet_operations_userId_kind_plan_expiresAt_idx"
  ON "wallet_operations"("userId", "kind", "plan", "expiresAt");
