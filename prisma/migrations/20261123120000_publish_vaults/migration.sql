-- Шифр логина и пароля площадки. Открытого текста в таблице нет.
CREATE TABLE "publish_vaults" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "loginSeal" TEXT NOT NULL,
    "passwordSeal" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "publish_vaults_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "publish_vaults_userId_platform_key" ON "publish_vaults"("userId", "platform");
CREATE INDEX "publish_vaults_userId_idx" ON "publish_vaults"("userId");

ALTER TABLE "publish_vaults" ADD CONSTRAINT "publish_vaults_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
