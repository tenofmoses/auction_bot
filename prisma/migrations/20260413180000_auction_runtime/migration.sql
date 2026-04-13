-- CreateEnum
CREATE TYPE "AuctionStatus" AS ENUM ('PENDING', 'ACTIVE', 'ENDED');

-- AlterTable
ALTER TABLE "Auction"
ADD COLUMN "status" "AuctionStatus" NOT NULL DEFAULT 'PENDING',
ADD COLUMN "startedAt" TIMESTAMP(3),
ADD COLUMN "endedAt" TIMESTAMP(3),
ADD COLUMN "lastBidAt" TIMESTAMP(3),
ADD COLUMN "messageId" INTEGER,
ADD COLUMN "currentPrice" INTEGER,
ADD COLUMN "winnerTelegramId" TEXT,
ADD COLUMN "winnerTelegramUsername" TEXT;

-- CreateTable
CREATE TABLE "Bid" (
  "id" TEXT NOT NULL,
  "auctionId" TEXT NOT NULL,
  "increment" INTEGER NOT NULL,
  "totalPrice" INTEGER NOT NULL,
  "bidderTelegramId" TEXT NOT NULL,
  "bidderTelegramUsername" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "Bid_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Bid_auctionId_createdAt_idx" ON "Bid"("auctionId", "createdAt" DESC);

-- AddForeignKey
ALTER TABLE "Bid" ADD CONSTRAINT "Bid_auctionId_fkey" FOREIGN KEY ("auctionId") REFERENCES "Auction"("id") ON DELETE CASCADE ON UPDATE CASCADE;
