CREATE TABLE "photo_shares" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "hrefHash" TEXT NOT NULL,
    "href" TEXT NOT NULL,
    "title" TEXT NOT NULL DEFAULT '',
    "visibility" TEXT NOT NULL DEFAULT 'private',
    "token" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "photo_shares_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "photo_shares_token_key" ON "photo_shares"("token");
CREATE UNIQUE INDEX "photo_shares_userId_hrefHash_key" ON "photo_shares"("userId", "hrefHash");
CREATE INDEX "photo_shares_userId_idx" ON "photo_shares"("userId");

ALTER TABLE "photo_shares" ADD CONSTRAINT "photo_shares_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "photo_viewers" (
    "photoId" TEXT NOT NULL,
    "viewerId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "photo_viewers_pkey" PRIMARY KEY ("photoId","viewerId")
);

CREATE INDEX "photo_viewers_viewerId_idx" ON "photo_viewers"("viewerId");

ALTER TABLE "photo_viewers" ADD CONSTRAINT "photo_viewers_photoId_fkey" FOREIGN KEY ("photoId") REFERENCES "photo_shares"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "photo_viewers" ADD CONSTRAINT "photo_viewers_viewerId_fkey" FOREIGN KEY ("viewerId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
