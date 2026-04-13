-- CreateTable
CREATE TABLE IF NOT EXISTS "Card" (
  "id" INTEGER NOT NULL,
  "cardUrl" TEXT,
  "coverMid" TEXT NOT NULL,
  "characterName" TEXT,
  "authorId" INTEGER,
  "authorUsername" TEXT NOT NULL,
  "titleMainName" TEXT NOT NULL,
  "titleDir" TEXT NOT NULL,
  "titleId" INTEGER NOT NULL,

  CONSTRAINT "Card_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "Auction" (
  "id" TEXT NOT NULL,
  "cardId" INTEGER NOT NULL,
  "startPrice" INTEGER,
  "startTime" TIMESTAMP(3),
  "starterTelegramId" TEXT,
  "starterTelegramUsername" TEXT,
  "channelId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "Auction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Auction_cardId_idx" ON "Auction"("cardId");

-- AddForeignKey
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'Auction_cardId_fkey'
  ) THEN
    ALTER TABLE "Auction"
      ADD CONSTRAINT "Auction_cardId_fkey"
      FOREIGN KEY ("cardId") REFERENCES "Card"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END
$$;
