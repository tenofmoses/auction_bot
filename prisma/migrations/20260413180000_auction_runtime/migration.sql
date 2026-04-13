-- CreateEnum
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type WHERE typname = 'AuctionStatus'
  ) THEN
    CREATE TYPE "AuctionStatus" AS ENUM ('PENDING', 'ACTIVE', 'ENDED');
  END IF;
END
$$;

-- AlterTable
ALTER TABLE IF EXISTS "Auction"
ADD COLUMN IF NOT EXISTS "status" "AuctionStatus" NOT NULL DEFAULT 'PENDING',
ADD COLUMN IF NOT EXISTS "startedAt" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS "endedAt" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS "lastBidAt" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS "messageId" INTEGER,
ADD COLUMN IF NOT EXISTS "currentPrice" INTEGER,
ADD COLUMN IF NOT EXISTS "winnerTelegramId" TEXT,
ADD COLUMN IF NOT EXISTS "winnerTelegramUsername" TEXT;

-- CreateTable
CREATE TABLE IF NOT EXISTS "Bid" (
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
CREATE INDEX IF NOT EXISTS "Bid_auctionId_createdAt_idx" ON "Bid"("auctionId", "createdAt" DESC);

-- AddForeignKey
DO $$
BEGIN
  IF to_regclass('"Auction"') IS NOT NULL
     AND to_regclass('"Bid"') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM pg_constraint WHERE conname = 'Bid_auctionId_fkey'
     ) THEN
    ALTER TABLE "Bid"
      ADD CONSTRAINT "Bid_auctionId_fkey"
      FOREIGN KEY ("auctionId") REFERENCES "Auction"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;
