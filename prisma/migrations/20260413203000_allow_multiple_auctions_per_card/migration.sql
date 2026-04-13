-- Drop unique index created in previous schema versions
DROP INDEX IF EXISTS "Auction_cardId_key";

-- Ensure non-unique index exists for query performance
CREATE INDEX IF NOT EXISTS "Auction_cardId_idx" ON "Auction"("cardId");
