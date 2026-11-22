-- Сообщения об ошибках, которые пользователи отправляют из шапки.
CREATE TABLE IF NOT EXISTS "app_error_reports" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "message" TEXT NOT NULL,
  "page" TEXT NOT NULL DEFAULT '',
  "status" TEXT NOT NULL DEFAULT 'new',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "app_error_reports_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "app_error_reports_status_createdAt_idx" ON "app_error_reports"("status", "createdAt");
CREATE INDEX IF NOT EXISTS "app_error_reports_userId_idx" ON "app_error_reports"("userId");

DO $$ BEGIN
  ALTER TABLE "app_error_reports"
    ADD CONSTRAINT "app_error_reports_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
