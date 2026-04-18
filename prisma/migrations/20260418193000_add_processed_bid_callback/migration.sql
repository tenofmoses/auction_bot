CREATE TABLE IF NOT EXISTS "ProcessedBidCallback" (
  "callbackId" TEXT NOT NULL,
  "auctionId" TEXT NOT NULL,
  "bidderTelegramId" TEXT NOT NULL,
  "increment" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProcessedBidCallback_pkey" PRIMARY KEY ("callbackId")
);

CREATE INDEX IF NOT EXISTS "ProcessedBidCallback_auctionId_createdAt_idx"
  ON "ProcessedBidCallback"("auctionId", "createdAt" DESC);
