-- Баланс ИИ и счета криптооплаты (провайдер пока выключен флагом).
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "aiBalanceCents" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS "crypto_payments" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "provider" TEXT NOT NULL DEFAULT 'nowpayments',
  "purpose" TEXT NOT NULL DEFAULT 'ai_balance',
  "amountUsdCents" INTEGER NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "providerId" TEXT,
  "invoiceUrl" TEXT,
  "creditedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "crypto_payments_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "crypto_payments_userId_idx" ON "crypto_payments"("userId");

DO $$ BEGIN
  ALTER TABLE "crypto_payments"
    ADD CONSTRAINT "crypto_payments_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
