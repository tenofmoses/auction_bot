import type { PrismaClient } from "@prisma/client";

type ParsedAuctionCommand = {
  cardUrl: string;
  cardId: number;
  startPrice: number | null;
  startTime: Date | null;
};

type CardApiResponse = {
  cover: { mid: string };
  character?: { name?: string };
  author: { id?: number; username: string };
  title: { main_name: string; dir: string; id: number };
};

type AuctionStarter = {
  telegramId: string | null;
  telegramUsername: string | null;
};

export type CreatedAuctionDetails = {
  characterName: string | null;
  titleMainName: string;
  titleDir: string;
  authorUsername: string;
  cardUrl: string;
  startPrice: number | null;
  startTime: Date | null;
  starterTelegramId: string | null;
  starterTelegramUsername: string | null;
};

export function parseAuctionCommand(commandText: string): ParsedAuctionCommand | null {
  const parts = commandText.split(/\s+/);
  if (parts.length < 2) return null;

  const url = parts[1];
  const cardIdMatch = url.match(/\/card\/(\d+)/);
  if (!cardIdMatch) return null;

  const cardId = parseInt(cardIdMatch[1], 10);

  let startPrice: number | null = null;
  let startTime: Date | null = null;

  for (const param of parts.slice(2)) {
    if (param.includes(":")) {
      const [hours, minutes] = param.split(":").map((value) => Number(value));
      if (Number.isNaN(hours) || Number.isNaN(minutes)) continue;
      const now = new Date();
      const mskTime = new Date(now.getTime() + 3 * 60 * 60 * 1000);
      mskTime.setHours(hours, minutes, 0, 0);
      startTime = mskTime;
      continue;
    }

    const parsedPrice = parseInt(param, 10);
    if (!Number.isNaN(parsedPrice)) {
      startPrice = parsedPrice;
    }
  }

  return { cardUrl: url, cardId, startPrice, startTime };
}

export async function createAuction(
  prisma: PrismaClient,
  command: ParsedAuctionCommand,
  auctionChannelId: string,
  starter: AuctionStarter,
): Promise<CreatedAuctionDetails> {
  const response = await fetch(`https://api.remanga.org/api/inventory/cards/${command.cardId}/`);
  if (!response.ok) throw new Error("Failed to fetch card data");

  const cardData = (await response.json()) as CardApiResponse;

  const card = await prisma.card.upsert({
    where: { id: command.cardId },
    update: {
      cardUrl: command.cardUrl,
      coverMid: cardData.cover.mid,
      characterName: cardData.character?.name ?? null,
      authorId: cardData.author.id ?? null,
      authorUsername: cardData.author.username,
      titleMainName: cardData.title.main_name,
      titleDir: cardData.title.dir,
      titleId: cardData.title.id,
    },
    create: {
      id: command.cardId,
      cardUrl: command.cardUrl,
      coverMid: cardData.cover.mid,
      characterName: cardData.character?.name ?? null,
      authorId: cardData.author.id ?? null,
      authorUsername: cardData.author.username,
      titleMainName: cardData.title.main_name,
      titleDir: cardData.title.dir,
      titleId: cardData.title.id,
    },
  });

  await prisma.auction.create({
    data: {
      cardId: card.id,
      startPrice: command.startPrice,
      startTime: command.startTime,
      starterTelegramId: starter.telegramId,
      starterTelegramUsername: starter.telegramUsername,
      channelId: auctionChannelId,
    },
  });

  return {
    characterName: card.characterName,
    titleMainName: card.titleMainName,
    titleDir: card.titleDir,
    authorUsername: card.authorUsername,
    cardUrl: command.cardUrl,
    startPrice: command.startPrice,
    startTime: command.startTime,
    starterTelegramId: starter.telegramId,
    starterTelegramUsername: starter.telegramUsername,
  };
}
