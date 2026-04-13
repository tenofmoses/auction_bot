export type ParsedAuctionCommand = {
  cardUrl: string;
  cardId: number;
  startPrice: number | null;
  startTime: Date | null;
};

export type CardApiResponse = {
  cover: { mid: string };
  character?: { name?: string };
  author: { id?: number; username: string };
  title: { main_name: string; dir: string; id: number };
};

export type AuctionStarter = {
  telegramId: string | null;
  telegramUsername: string | null;
};

export type CreatedAuctionDetails = {
  auctionId: string;
  characterName: string | null;
  titleMainName: string;
  titleDir: string;
  authorUsername: string;
  cardUrl: string;
  coverMid: string;
  startPrice: number | null;
  startTime: Date | null;
  starterTelegramId: string | null;
  starterTelegramUsername: string | null;
  channelId: string;
};

export type RecentBid = {
  bidderTelegramId: string;
  bidderTelegramUsername: string | null;
  totalPrice: number;
  createdAt: Date;
};

export type AuctionViewDetails = {
  characterName: string | null;
  titleMainName: string;
  titleDir: string;
  authorUsername: string;
  starterTelegramId: string | null;
  starterTelegramUsername: string | null;
  cardUrl: string;
  currentPrice: number;
  winnerTelegramId: string | null;
  winnerTelegramUsername: string | null;
  status: "ACTIVE" | "ENDED";
  lastBids: RecentBid[];
};

export type AuctionStatusValue = "PENDING" | "ACTIVE" | "ENDED";

export type AuctionWithCardAndBids = {
  id: string;
  status: AuctionStatusValue;
  channelId: string;
  startPrice: number | null;
  starterTelegramId: string | null;
  starterTelegramUsername: string | null;
  currentPrice: number | null;
  startTime: Date | null;
  startedAt: Date | null;
  createdAt: Date;
  lastBidAt: Date | null;
  messageId: number | null;
  winnerTelegramId: string | null;
  winnerTelegramUsername: string | null;
  card: {
    id: number;
    cardUrl: string | null;
    coverMid: string;
    characterName: string | null;
    titleMainName: string;
    titleDir: string;
    authorUsername: string;
  };
  bids: RecentBid[];
};

export type BidCallbackQuery = {
  id: string;
  data?: string;
  from: {
    id: number | string;
    username?: string;
  };
};
