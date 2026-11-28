CREATE TABLE IF NOT EXISTS "book_emoji_reactions" (
    "userId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "emoji" TEXT NOT NULL,
    CONSTRAINT "book_emoji_reactions_pkey" PRIMARY KEY ("userId", "projectId"),
    CONSTRAINT "book_emoji_reactions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "book_emoji_reactions_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "book_emoji_reactions_projectId_emoji_idx" ON "book_emoji_reactions"("projectId", "emoji");
