-- Зачисленная сумма и сторно криптоплатежа, как в контуре NOWPayments на TISMOS.
ALTER TABLE "crypto_payments" ADD COLUMN IF NOT EXISTS "creditedUsdCents" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "crypto_payments" ADD COLUMN IF NOT EXISTS "reversedAt" TIMESTAMP(3);
