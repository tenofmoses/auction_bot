import type { Prisma, PrismaClient } from "@prisma/client";
import type TelegramBot from "node-telegram-bot-api";
import { buildAuctionFinishedCaption, buildAuctionLiveCaption } from "../handlers/messageBuilders.js";
import type { AuctionViewDetails, AuctionWithCardAndBids, BidCallbackQuery } from "../types/auction.js";

const AUCTION_TARGET_THREAD_ID = 1273810;
const BID_INCREMENTS = [50, 100, 500, 1000] as const;
const CALLBACK_PREFIX = "auction_bid";
const auctionBidQueues = new Map<string, Promise<void>>();
const auctionEditBlockedUntil = new Map<string, number>();

function getRemainingMs(auction: AuctionWithCardAndBids, nowMs: number): number {
  const anchor = auction.lastBidAt ?? auction.startedAt ?? auction.createdAt;
  const timeoutMs = auction.bidTimeoutMinutes * 60 * 1000;
  return Math.max(0, timeoutMs - (nowMs - anchor.getTime()));
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

async function runInAuctionQueue(auctionId: string, task: () => Promise<void>): Promise<void> {
  const previous = auctionBidQueues.get(auctionId) ?? Promise.resolve();
  const current = previous
    .catch(() => {
      // Keep queue alive even if previous task failed.
    })
    .then(task);

  auctionBidQueues.set(auctionId, current);
  try {
    await current;
  } finally {
    if (auctionBidQueues.get(auctionId) === current) {
      auctionBidQueues.delete(auctionId);
    }
  }
}

function parseRetryAfterMs(errorText: string): number | null {
  const match = errorText.match(/retry after\s+(\d+)/i);
  if (!match) return null;
  const seconds = Number(match[1]);
  if (Number.isNaN(seconds) || seconds <= 0) return null;
  return seconds * 1000;
}

function mapAuctionView(auction: AuctionWithCardAndBids): AuctionViewDetails {
  return {
    characterName: auction.card.characterName,
    titleMainName: auction.card.titleMainName,
    titleDir: auction.card.titleDir,
    authorUsername: auction.card.authorUsername,
    starterTelegramId: auction.starterTelegramId,
    starterTelegramUsername: auction.starterTelegramUsername,
    cardUrl: auction.card.cardUrl ?? `https://remanga.org/card/${auction.card.id}`,
    currentPrice: auction.currentPrice ?? auction.startPrice ?? 0,
    winnerTelegramId: auction.winnerTelegramId,
    winnerTelegramUsername: auction.winnerTelegramUsername,
    status: auction.status === "ENDED" ? "ENDED" : "ACTIVE",
    lastBids: auction.bids,
  };
}

async function pinAuctionMessage(bot: TelegramBot, chatId: string, messageId: number): Promise<void> {
  try {
    await bot.pinChatMessage(chatId, messageId, { disable_notification: true });
  } catch (error) {
    console.error("[auction-runtime] Failed to pin auction message", {
      chatId,
      messageId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
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
) {
  if (auction.messageId) {
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
      await pinAuctionMessage(bot, auction.channelId, auction.messageId);
      return;
    } catch (error) {
      const err = error instanceof Error ? error.message : String(error);
      if (err.includes("message is not modified")) return;
      // Could be text-only message or deleted message.
    }

    try {
      await bot.editMessageText(caption, editOptions);
      await pinAuctionMessage(bot, auction.channelId, auction.messageId);
      return;
    } catch (error) {
      const err = error instanceof Error ? error.message : String(error);
      if (err.includes("message is not modified")) return;
      console.error("[auction-runtime] Failed to edit current auction message, creating new one", {
        auctionId: auction.id,
        messageId: auction.messageId,
        error: err,
      });
    }
  }

  const sent = await sendAuctionMessage(bot, auction.channelId, auction, true, false);
  if (!sent.message_id) return;

  await prisma.auction.update({
    where: { id: auction.id },
    data: { messageId: sent.message_id },
  });
  await pinAuctionMessage(bot, auction.channelId, sent.message_id);
}

async function refreshAuctionMessageCountdown(
  bot: TelegramBot,
  auction: AuctionWithCardAndBids,
): Promise<{ messageMissing: boolean; retryAfterMs: number | null }> {
  if (!auction.messageId || auction.status !== "ACTIVE") {
    return { messageMissing: false, retryAfterMs: null };
  }

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
    return { messageMissing: false, retryAfterMs: null };
  } catch (error) {
    const err = error instanceof Error ? error.message : String(error);
    const retryAfterMs = parseRetryAfterMs(err);
    if (retryAfterMs) return { messageMissing: false, retryAfterMs };
    if (err.includes("message to edit not found")) return { messageMissing: true, retryAfterMs: null };
    if (err.includes("message is not modified")) return { messageMissing: false, retryAfterMs: null };
    // Try text edit only when Telegram explicitly says caption edit is impossible for this message type.
    if (!err.toLowerCase().includes("caption")) {
      console.error("[auction-runtime] Failed to refresh auction caption", {
        auctionId: auction.id,
        messageId: auction.messageId,
        error: err,
      });
      return { messageMissing: false, retryAfterMs: null };
    }
  }

  try {
    await bot.editMessageText(caption, editOptions);
    return { messageMissing: false, retryAfterMs: null };
  } catch (error) {
    const err = error instanceof Error ? error.message : String(error);
    const retryAfterMs = parseRetryAfterMs(err);
    if (retryAfterMs) return { messageMissing: false, retryAfterMs };
    if (err.includes("message to edit not found")) return { messageMissing: true, retryAfterMs: null };
    if (err.includes("message is not modified")) return { messageMissing: false, retryAfterMs: null };
    if (err.toLowerCase().includes("there is no text in the message to edit")) {
      return { messageMissing: false, retryAfterMs: null };
    }
    console.error("[auction-runtime] Failed to refresh auction countdown", {
      auctionId: auction.id,
      messageId: auction.messageId,
      error: err,
    });
    return { messageMissing: false, retryAfterMs: null };
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

  const activated = await prisma.auction.updateMany({
    where: {
      id: auction.id,
      status: "PENDING",
      OR: [{ startTime: null }, { startTime: { lte: now } }],
    },
    data: {
      status: "ACTIVE",
      startedAt: now,
      lastBidAt: now,
      currentPrice: startPrice,
    },
  });

  if (activated.count === 0) {
    return;
  }

  const updated = await prisma.auction.findUnique({
    where: { id: auction.id },
    include: {
      card: true,
      bids: { orderBy: { createdAt: "desc" }, take: 3 },
    },
  });

  if (!updated) return;

  await publishLiveMessage(prisma, bot, updated);
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

  await runInAuctionQueue(auctionId, async () => {
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
    const lastBidTime = current.lastBidAt ?? current.startedAt ?? current.createdAt;
    if (now.getTime() - lastBidTime.getTime() >= current.bidTimeoutMinutes * 60 * 1000) {
      await finishAuction(prisma, bot, current.id);
      await bot.answerCallbackQuery(query.id, { text: "Аукцион завершён", show_alert: true });
      return;
    }

    let outbidUser: string | null = null;
    await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const latest = await tx.auction.findUnique({
        where: { id: auctionId },
        select: {
          status: true,
          currentPrice: true,
          startPrice: true,
          winnerTelegramId: true,
          winnerTelegramUsername: true,
        },
      });
      if (!latest || latest.status !== "ACTIVE") {
        throw new Error("Auction is not active");
      }

      if (latest.winnerTelegramId && latest.winnerTelegramId !== String(query.from.id)) {
        outbidUser = latest.winnerTelegramUsername
          ? `@${latest.winnerTelegramUsername}`
          : `user_${latest.winnerTelegramId}`;
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

    try {
      await publishLiveMessage(prisma, bot, updated);
    } catch (error) {
      console.error("[auction-runtime] Bid saved, but failed to refresh auction message", {
        auctionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    if (outbidUser) {
      try {
        await bot.sendMessage(updated.channelId, `⚠️ ${outbidUser}, вашу ставку перебили.`, {
          message_thread_id: AUCTION_TARGET_THREAD_ID,
        });
      } catch (error) {
        console.error("[auction-runtime] Bid saved, but failed to send outbid notification", {
          auctionId,
          outbidUser,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    await bot.answerCallbackQuery(query.id, { text: `Ставка +${increment} принята` });
  });
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
  const active = await prisma.auction.findMany({
    where: {
      status: "ACTIVE",
    },
    select: {
      id: true,
      bidTimeoutMinutes: true,
      lastBidAt: true,
      startedAt: true,
      createdAt: true,
    },
    take: 20,
  });

  const nowMs = Date.now();
  for (const auction of active) {
    const anchor = auction.lastBidAt ?? auction.startedAt ?? auction.createdAt;
    const timeoutMs = auction.bidTimeoutMinutes * 60 * 1000;
    if (nowMs - anchor.getTime() >= timeoutMs) {
      await finishAuction(prisma, bot, auction.id);
    }
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
    const blockedUntil = auctionEditBlockedUntil.get(auction.id) ?? 0;
    if (Date.now() < blockedUntil) continue;

    const remainingMs = getRemainingMs(auction, Date.now());
    if (remainingMs <= 0) {
      await finishAuction(prisma, bot, auction.id);
      continue;
    }

    if (!auction.messageId) {
      await publishLiveMessage(prisma, bot, auction);
      continue;
    }

    const refreshResult = await refreshAuctionMessageCountdown(bot, auction);
    if (refreshResult.retryAfterMs) {
      auctionEditBlockedUntil.set(auction.id, Date.now() + refreshResult.retryAfterMs);
      continue;
    }

    if (refreshResult.messageMissing) {
      const reset = await prisma.auction.update({
        where: { id: auction.id },
        data: { messageId: null },
        include: {
          card: true,
          bids: { orderBy: { createdAt: "desc" }, take: 3 },
        },
      });
      await publishLiveMessage(prisma, bot, reset);
    }
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
  }, 3_000);
}
