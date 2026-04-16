import type { PrismaClient } from "@prisma/client";
import type { AuctionStarter, CardApiResponse, CreatedAuctionDetails, ParsedAuctionCommand } from "../types/auction.js";

const CARD_FETCH_TIMEOUT_MS = 8_000;
const CARD_FETCH_ATTEMPTS = 3;

function isRetryableFetchError(error: unknown): boolean {
  const anyError = error as { name?: string; code?: string; message?: string };
  if (anyError?.name === "AbortError") return true;

  const code = anyError?.code ?? "";
  const retryableCodes = new Set(["ETIMEDOUT", "ECONNRESET", "ECONNABORTED", "ENOTFOUND", "EAI_AGAIN", "EPIPE"]);
  if (retryableCodes.has(code)) return true;

  const message = (anyError?.message ?? String(error)).toLowerCase();
  if (message.includes("timeout")) return true;
  if (message.includes("network")) return true;
  if (message.includes("fetch failed")) return true;
  return false;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchCardData(cardId: number): Promise<CardApiResponse> {
  let lastError: unknown = null;
  const url = `https://api.remanga.org/api/inventory/cards/${cardId}/`;

  for (let attempt = 1; attempt <= CARD_FETCH_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CARD_FETCH_TIMEOUT_MS);

    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) {
        // 4xx are usually permanent; 5xx are transient and worth retrying.
        if (response.status >= 500 && attempt < CARD_FETCH_ATTEMPTS) {
          await sleep(300 * attempt);
          continue;
        }
        throw new Error(`Failed to fetch card data: ${response.status} ${response.statusText}`);
      }
      return (await response.json()) as CardApiResponse;
    } catch (error) {
      lastError = error;
      if (attempt >= CARD_FETCH_ATTEMPTS || !isRetryableFetchError(error)) {
        throw error;
      }
      await sleep(300 * attempt);
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Failed to fetch card data");
}

export function parseAuctionCommand(commandText: string): ParsedAuctionCommand | null {
  const parts = commandText.split(/\s+/);
  if (parts.length < 2) return null;

  const url = parts[1];
  const cardIdMatch = url.match(/\/card\/(\d+)/);
  if (!cardIdMatch) return null;

  const cardId = parseInt(cardIdMatch[1], 10);

  let startPrice: number | null = null;
  let startTime: Date | null = null;
  let bidTimeoutMinutes = 60;

  for (const param of parts.slice(2)) {
    if (param.includes(":")) {
      const [hours, minutes] = param.split(":").map((value) => Number(value));
      if (
        Number.isNaN(hours) ||
        Number.isNaN(minutes) ||
        hours < 0 ||
        hours > 23 ||
        minutes < 0 ||
        minutes > 59
      ) continue;

      const now = new Date();
      const mskOffsetMs = 3 * 60 * 60 * 1000;
      const nowMsk = new Date(now.getTime() + mskOffsetMs);

      const targetMskUtc = Date.UTC(
        nowMsk.getUTCFullYear(),
        nowMsk.getUTCMonth(),
        nowMsk.getUTCDate(),
        hours,
        minutes,
        0,
        0,
      );

      let targetUtcMs = targetMskUtc - mskOffsetMs;
      if (targetUtcMs <= now.getTime()) {
        targetUtcMs += 24 * 60 * 60 * 1000;
      }

      startTime = new Date(targetUtcMs);
      continue;
    }

    const timeoutMatch = param.match(/^(\d+)(m|min|h|м|ч)$/i);
    if (timeoutMatch) {
      const value = Number(timeoutMatch[1]);
      const unit = timeoutMatch[2].toLowerCase();
      if (!Number.isNaN(value) && value > 0) {
        bidTimeoutMinutes = unit === "h" || unit === "ч" ? value * 60 : value;
      }
      continue;
    }

    const parsedPrice = parseInt(param, 10);
    if (!Number.isNaN(parsedPrice)) {
      startPrice = parsedPrice;
    }
  }

  return { cardUrl: url, cardId, startPrice, startTime, bidTimeoutMinutes };
}

export async function createAuction(
  prisma: PrismaClient,
  command: ParsedAuctionCommand,
  auctionChannelId: string,
  starter: AuctionStarter,
): Promise<CreatedAuctionDetails> {
  console.log("[auction] Fetching card data", {
    cardId: command.cardId,
    cardUrl: command.cardUrl,
  });
  let cardData: CardApiResponse;
  try {
    cardData = await fetchCardData(command.cardId);
  } catch (error) {
    console.error("[auction] Failed to fetch card data", {
      cardId: command.cardId,
      error: error instanceof Error ? error.message : String(error),
    });
    throw new Error("Failed to fetch card data");
  }
  const coverMid = cardData.cover?.mid ?? "https://remanga.org/favicon.ico";
  const authorUsername = cardData.author?.username ?? "unknown_author";
  const authorId = cardData.author?.id ?? null;
  const titleMainName = cardData.title?.main_name ?? "Не указано";
  const titleDir = cardData.title?.dir ?? "unknown";
  const titleId = cardData.title?.id ?? 0;

  console.log("[auction] Card data fetched", {
    cardId: command.cardId,
    authorUsername,
    titleDir,
    hasIncompleteFields:
      !cardData.cover?.mid || !cardData.author?.username || !cardData.title?.main_name || !cardData.title?.dir,
  });

  const card = await prisma.card.upsert({
    where: { id: command.cardId },
    update: {
      cardUrl: command.cardUrl,
      coverMid,
      characterName: cardData.character?.name ?? null,
      authorId,
      authorUsername,
      titleMainName,
      titleDir,
      titleId,
    },
    create: {
      id: command.cardId,
      cardUrl: command.cardUrl,
      coverMid,
      characterName: cardData.character?.name ?? null,
      authorId,
      authorUsername,
      titleMainName,
      titleDir,
      titleId,
    },
  });
  console.log("[auction] Card upserted", {
    cardId: card.id,
    titleDir: card.titleDir,
  });

  const auction = await prisma.auction.create({
    data: {
      cardId: card.id,
      startPrice: command.startPrice,
      startTime: command.startTime,
      bidTimeoutMinutes: command.bidTimeoutMinutes,
      starterTelegramId: starter.telegramId,
      starterTelegramUsername: starter.telegramUsername,
      channelId: auctionChannelId,
    },
  });
  console.log("[auction] Auction record created", {
    cardId: card.id,
    channelId: auctionChannelId,
    starterTelegramId: starter.telegramId,
  });

  return {
    auctionId: auction.id,
    characterName: card.characterName,
    titleMainName: card.titleMainName,
    titleDir: card.titleDir,
    authorUsername: card.authorUsername,
    cardUrl: command.cardUrl,
    coverMid: card.coverMid,
    startPrice: command.startPrice,
    startTime: command.startTime,
    bidTimeoutMinutes: command.bidTimeoutMinutes,
    starterTelegramId: starter.telegramId,
    starterTelegramUsername: starter.telegramUsername,
    channelId: auctionChannelId,
  };
}
