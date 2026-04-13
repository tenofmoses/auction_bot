-- CreateTable
CREATE TABLE "Card" (
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
CREATE TABLE "Auction" (
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
CREATE UNIQUE INDEX "Auction_cardId_key" ON "Auction"("cardId");

-- AddForeignKey
ALTER TABLE "Auction" ADD CONSTRAINT "Auction_cardId_fkey" FOREIGN KEY ("cardId") REFERENCES "Card"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
