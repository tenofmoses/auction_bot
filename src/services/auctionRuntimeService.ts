import type { Prisma, PrismaClient } from "@prisma/client";
import type TelegramBot from "node-telegram-bot-api";
import { buildAuctionFinishedCaption, buildAuctionLiveCaption } from "../handlers/messageBuilders.js";
import type { AuctionViewDetails, AuctionWithCardAndBids, BidCallbackQuery } from "../types/auction.js";

const AUCTION_TARGET_THREAD_ID = 1273810;
const BID_TIMEOUT_MS = 60 * 60 * 1000;
const BID_INCREMENTS = [50, 100, 500, 1000] as const;
const CALLBACK_PREFIX = "auction_bid";

function getRemainingMs(auction: AuctionWithCardAndBids, nowMs: number): number {
  const anchor = auction.lastBidAt ?? auction.startedAt ?? auction.createdAt;
  return Math.max(0, BID_TIMEOUT_MS - (nowMs - anchor.getTime()));
}

function toCoverUrl(coverMid: string): string {
  if (coverMid.startsWith("https://") || coverMid.startsWith("http://")) return coverMid;
  if (coverMid.startsWith("//")) return `https:${coverMid}`;
  if (coverMid.startsWith("/")) return `https://api.remanga.org${coverMid}`;
  return `https://${coverMid}`;
}

function buildBidKeyboard(auctionId: string) {
  return {
    inline_keyboard: [
      BID_INCREMENTS.map((increment) => ({
        text: `+${increment}`,
        callback_data: `${CALLBACK_PREFIX}:${auctionId}:${increment}`,
      })),
    ],
  };
}

function mapAuctionView(auction: AuctionWithCardAndBids): AuctionViewDetails {
  return {
    characterName: auction.card.characterName,
    titleMainName: auction.card.titleMainName,
    titleDir: auction.card.titleDir,
    authorUsername: auction.card.authorUsername,
    cardUrl: auction.card.cardUrl ?? `https://remanga.org/card/${auction.card.id}`,
    currentPrice: auction.currentPrice ?? auction.startPrice ?? 0,
    winnerTelegramId: auction.winnerTelegramId,
    winnerTelegramUsername: auction.winnerTelegramUsername,
    status: auction.status === "ENDED" ? "ENDED" : "ACTIVE",
    lastBids: auction.bids,
  };
}

async function sendAuctionMessage(
  bot: TelegramBot,
  channelId: string,
  auction: AuctionWithCardAndBids,
  withButtons: boolean,
  isFinal: boolean,
) {
  const view = mapAuctionView(auction);
  const remainingMs = getRemainingMs(auction, Date.now());
  const caption = isFinal ? buildAuctionFinishedCaption(view) : buildAuctionLiveCaption(view, remainingMs);
  const replyMarkup = withButtons ? { reply_markup: buildBidKeyboard(auction.id) } : undefined;

  try {
    return await bot.sendPhoto(channelId, toCoverUrl(auction.card.coverMid), {
      caption,
      parse_mode: "HTML",
      message_thread_id: AUCTION_TARGET_THREAD_ID,
      ...replyMarkup,
    });
  } catch (error) {
    console.error("[auction-runtime] Failed to send photo, fallback to text", {
      auctionId: auction.id,
      error: error instanceof Error ? error.message : String(error),
    });
    return await bot.sendMessage(channelId, caption, {
      parse_mode: "HTML",
      message_thread_id: AUCTION_TARGET_THREAD_ID,
      ...replyMarkup,
    });
  }
}

async function publishLiveMessage(
  prisma: PrismaClient,
  bot: TelegramBot,
  auction: AuctionWithCardAndBids,
  deleteMessageId: number | null,
) {
  if (deleteMessageId) {
    try {
      await bot.deleteMessage(auction.channelId, deleteMessageId);
    } catch (error) {
      console.error("[auction-runtime] Failed to delete previous message", {
        auctionId: auction.id,
        messageId: deleteMessageId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const sent = await sendAuctionMessage(bot, auction.channelId, auction, true, false);
  if (!sent.message_id) return;

  await prisma.auction.update({
    where: { id: auction.id },
    data: { messageId: sent.message_id },
  });
}

async function refreshAuctionMessageCountdown(bot: TelegramBot, auction: AuctionWithCardAndBids): Promise<void> {
  if (!auction.messageId || auction.status !== "ACTIVE") return;

  const remainingMs = getRemainingMs(auction, Date.now());
  const caption = buildAuctionLiveCaption(mapAuctionView(auction), remainingMs);
  const editOptions = {
    chat_id: auction.channelId,
    message_id: auction.messageId,
    parse_mode: "HTML" as const,
    message_thread_id: AUCTION_TARGET_THREAD_ID,
    reply_markup: buildBidKeyboard(auction.id),
  };

  try {
    await bot.editMessageCaption(caption, editOptions);
    return;
  } catch (error) {
    const err = error instanceof Error ? error.message : String(error);
    if (err.includes("message is not modified")) return;
    // Could be text-only message after fallback.
  }

  try {
    await bot.editMessageText(caption, editOptions);
  } catch (error) {
    const err = error instanceof Error ? error.message : String(error);
    if (err.includes("message is not modified")) return;
    console.error("[auction-runtime] Failed to refresh auction countdown", {
      auctionId: auction.id,
      messageId: auction.messageId,
      error: err,
    });
  }
}

export async function startAuctionIfDue(prisma: PrismaClient, bot: TelegramBot, auctionId: string): Promise<void> {
  const auction = await prisma.auction.findUnique({
    where: { id: auctionId },
    include: {
      card: true,
      bids: { orderBy: { createdAt: "desc" }, take: 3 },
    },
  });

  if (!auction || auction.status !== "PENDING") return;
  if (auction.startTime && auction.startTime.getTime() > Date.now()) return;

  const now = new Date();
  const startPrice = auction.startPrice ?? 0;
  const updated = await prisma.auction.update({
    where: { id: auction.id },
    data: {
      status: "ACTIVE",
      startedAt: now,
      lastBidAt: now,
      currentPrice: startPrice,
    },
    include: {
      card: true,
      bids: { orderBy: { createdAt: "desc" }, take: 3 },
    },
  });

  await publishLiveMessage(prisma, bot, updated, updated.messageId);
  console.log("[auction-runtime] Auction started", {
    auctionId: updated.id,
    channelId: updated.channelId,
  });
}

export async function handleBidCallback(
  prisma: PrismaClient,
  bot: TelegramBot,
  query: BidCallbackQuery,
): Promise<void> {
  const raw = query.data?.trim();
  if (!raw || !raw.startsWith(`${CALLBACK_PREFIX}:`)) return;

  const [, auctionId, incrementRaw] = raw.split(":");
  const increment = Number(incrementRaw);
  if (!auctionId || !BID_INCREMENTS.includes(increment as (typeof BID_INCREMENTS)[number])) {
    await bot.answerCallbackQuery(query.id, { text: "Некорректная ставка", show_alert: true });
    return;
  }

  const current = await prisma.auction.findUnique({
    where: { id: auctionId },
    include: {
      card: true,
      bids: { orderBy: { createdAt: "desc" }, take: 3 },
    },
  });

  if (!current || current.status !== "ACTIVE") {
    await bot.answerCallbackQuery(query.id, { text: "Аукцион уже не активен", show_alert: true });
    return;
  }

  const now = new Date();
  const previousLeader =
    current.winnerTelegramId && current.winnerTelegramId !== String(query.from.id)
      ? current.winnerTelegramUsername
        ? `@${current.winnerTelegramUsername}`
        : `user_${current.winnerTelegramId}`
      : null;
  const lastBidTime = current.lastBidAt ?? current.startedAt ?? current.createdAt;
  if (now.getTime() - lastBidTime.getTime() >= BID_TIMEOUT_MS) {
    await finishAuction(prisma, bot, current.id);
    await bot.answerCallbackQuery(query.id, { text: "Аукцион завершён", show_alert: true });
    return;
  }

  const previousMessageId = current.messageId;
  await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const latest = await tx.auction.findUnique({
      where: { id: auctionId },
      select: {
        status: true,
        currentPrice: true,
        startPrice: true,
      },
    });
    if (!latest || latest.status !== "ACTIVE") {
      throw new Error("Auction is not active");
    }

    const newTotal = (latest.currentPrice ?? latest.startPrice ?? 0) + increment;
    await tx.bid.create({
      data: {
        auctionId,
        increment,
        totalPrice: newTotal,
        bidderTelegramId: String(query.from.id),
        bidderTelegramUsername: query.from.username ?? null,
      },
    });

    await tx.auction.update({
      where: { id: auctionId },
      data: {
        currentPrice: newTotal,
        winnerTelegramId: String(query.from.id),
        winnerTelegramUsername: query.from.username ?? null,
        lastBidAt: now,
      },
    });
  });

  const updated = await prisma.auction.findUnique({
    where: { id: auctionId },
    include: {
      card: true,
      bids: { orderBy: { createdAt: "desc" }, take: 3 },
    },
  });

  if (!updated) {
    await bot.answerCallbackQuery(query.id, { text: "Не удалось обновить ставку", show_alert: true });
    return;
  }

  await publishLiveMessage(prisma, bot, updated, previousMessageId);
  if (previousLeader) {
    await bot.sendMessage(updated.channelId, `⚠️ ${previousLeader}, вашу ставку перебили.`, {
      message_thread_id: AUCTION_TARGET_THREAD_ID,
    });
  }
  await bot.answerCallbackQuery(query.id, { text: `Ставка +${increment} принята` });
}

export async function finishAuction(prisma: PrismaClient, bot: TelegramBot, auctionId: string): Promise<void> {
  const auction = await prisma.auction.findUnique({
    where: { id: auctionId },
    include: {
      card: true,
      bids: { orderBy: { createdAt: "desc" }, take: 3 },
    },
  });

  if (!auction || auction.status === "ENDED") return;

  const ended = await prisma.auction.update({
    where: { id: auctionId },
    data: {
      status: "ENDED",
      endedAt: new Date(),
    },
    include: {
      card: true,
      bids: { orderBy: { createdAt: "desc" }, take: 3 },
    },
  });

  if (ended.messageId) {
    try {
      await bot.deleteMessage(ended.channelId, ended.messageId);
    } catch (error) {
      console.error("[auction-runtime] Failed to delete final live message", {
        auctionId: ended.id,
        messageId: ended.messageId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  await sendAuctionMessage(bot, ended.channelId, ended, false, true);
  console.log("[auction-runtime] Auction finished", {
    auctionId: ended.id,
    channelId: ended.channelId,
    winnerTelegramId: ended.winnerTelegramId,
  });
}

export async function cancelAuction(
  prisma: PrismaClient,
  bot: TelegramBot,
  auctionId: string,
  canceledByUsername: string | null,
): Promise<void> {
  const auction = await prisma.auction.findUnique({
    where: { id: auctionId },
    include: {
      card: true,
      bids: { orderBy: { createdAt: "desc" }, take: 3 },
    },
  });

  if (!auction || auction.status === "ENDED") return;

  const ended = await prisma.auction.update({
    where: { id: auctionId },
    data: {
      status: "ENDED",
      endedAt: new Date(),
    },
    include: {
      card: true,
      bids: { orderBy: { createdAt: "desc" }, take: 3 },
    },
  });

  if (ended.messageId) {
    try {
      await bot.deleteMessage(ended.channelId, ended.messageId);
    } catch (error) {
      console.error("[auction-runtime] Failed to delete canceled auction message", {
        auctionId: ended.id,
        messageId: ended.messageId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const byText = canceledByUsername ? `@${canceledByUsername}` : "организатором";
  const cancelText = `⛔️ Аукцион прерван ${byText}.\n🃏 Карта: ${ended.card.cardUrl ?? `https://remanga.org/card/${ended.card.id}`}`;
  try {
    await bot.sendPhoto(ended.channelId, toCoverUrl(ended.card.coverMid), {
      caption: cancelText,
      parse_mode: "HTML",
      message_thread_id: AUCTION_TARGET_THREAD_ID,
    });
  } catch (error) {
    console.error("[auction-runtime] Failed to send canceled auction photo, fallback to text", {
      auctionId: ended.id,
      error: error instanceof Error ? error.message : String(error),
    });
    await bot.sendMessage(ended.channelId, cancelText, {
      disable_web_page_preview: true,
      message_thread_id: AUCTION_TARGET_THREAD_ID,
    });
  }

  console.log("[auction-runtime] Auction canceled", {
    auctionId: ended.id,
    channelId: ended.channelId,
    canceledByUsername,
  });
}

async function processPendingStarts(prisma: PrismaClient, bot: TelegramBot): Promise<void> {
  const due = await prisma.auction.findMany({
    where: {
      status: "PENDING",
      OR: [{ startTime: null }, { startTime: { lte: new Date() } }],
    },
    select: { id: true },
    take: 20,
  });

  for (const auction of due) {
    await startAuctionIfDue(prisma, bot, auction.id);
  }
}

async function processExpiredAuctions(prisma: PrismaClient, bot: TelegramBot): Promise<void> {
  const threshold = new Date(Date.now() - BID_TIMEOUT_MS);
  const expired = await prisma.auction.findMany({
    where: {
      status: "ACTIVE",
      lastBidAt: { lte: threshold },
    },
    select: { id: true },
    take: 20,
  });

  for (const auction of expired) {
    await finishAuction(prisma, bot, auction.id);
  }
}

async function refreshActiveAuctionCountdowns(prisma: PrismaClient, bot: TelegramBot): Promise<void> {
  const activeAuctions = await prisma.auction.findMany({
    where: { status: "ACTIVE" },
    include: {
      card: true,
      bids: { orderBy: { createdAt: "desc" }, take: 3 },
    },
    take: 20,
  });

  for (const auction of activeAuctions) {
    const remainingMs = getRemainingMs(auction, Date.now());
    if (remainingMs <= 0) {
      await finishAuction(prisma, bot, auction.id);
      continue;
    }
    await refreshAuctionMessageCountdown(bot, auction);
  }
}

export function initAuctionRuntime(prisma: PrismaClient, bot: TelegramBot): void {
  let isTickRunning = false;
  const tick = async () => {
    if (isTickRunning) return;
    isTickRunning = true;
    try {
      await processPendingStarts(prisma, bot);
      await processExpiredAuctions(prisma, bot);
      await refreshActiveAuctionCountdowns(prisma, bot);
    } catch (error) {
      console.error("[auction-runtime] Tick failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      isTickRunning = false;
    }
  };

  void tick();
  setInterval(() => {
    void tick();
  }, 1_000);
}
