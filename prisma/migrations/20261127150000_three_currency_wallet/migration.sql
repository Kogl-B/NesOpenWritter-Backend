ALTER TABLE "users" ADD COLUMN "rubBalanceCents" BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "wallet_operations"
  ADD COLUMN "fromCurrency" TEXT,
  ADD COLUMN "toCurrency" TEXT,
  ADD COLUMN "exchangeQuote" JSONB;
ALTER TABLE "crypto_payments" ADD COLUMN "priceQuote" JSONB;
