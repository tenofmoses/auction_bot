import type { PrismaClient } from "@prisma/client";
import type TelegramBot from "node-telegram-bot-api";
import {
  buildAuctionFinishedAnnouncement,
  buildAuctionFinishedCaption,
  buildAuctionLiveCaption,
} from "../handlers/messageBuilders.js";
import { sendMessageWithRetry, sendPhotoWithRetry } from "./telegramDeliveryService.js";
import type { AuctionViewDetails, AuctionWithCardAndBids, BidCallbackQuery } from "../types/auction.js";

const AUCTION_TARGET_THREAD_ID = 1273810;
const BID_INCREMENTS = [50, 100, 500, 1000] as const;
const CALLBACK_PREFIX = "auction_bid";
const auctionTaskQueues = new Map<string, Promise<void>>();
const auctionEditBlockedUntil = new Map<string, number>();

function isUniqueConstraintError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const maybeCode = (error as { code?: unknown }).code;
  return maybeCode === "P2002";
}

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
  const previous = auctionTaskQueues.get(auctionId) ?? Promise.resolve();
  const current = previous
    .catch(() => {
      // Keep queue alive even if previous task failed.
    })
    .then(task);

  auctionTaskQueues.set(auctionId, current);
  try {
    await current;
  } finally {
    if (auctionTaskQueues.get(auctionId) === current) {
      auctionTaskQueues.delete(auctionId);
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

async function unpinAuctionMessage(bot: TelegramBot, chatId: string, messageId?: number | null): Promise<void> {
  try {
    if (messageId) {
      await bot.unpinChatMessage(chatId, { message_id: messageId });
    } else {
      await bot.unpinChatMessage(chatId);
    }
  } catch (error) {
    console.error("[auction-runtime] Failed to unpin auction message", {
      chatId,
      messageId: messageId ?? null,
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
    return await sendPhotoWithRetry(bot, channelId, toCoverUrl(auction.card.coverMid), {
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
    return await sendMessageWithRetry(bot, channelId, caption, {
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

    let shouldCreateNew = false;
    try {
      await bot.editMessageCaption(caption, editOptions);
      await pinAuctionMessage(bot, auction.channelId, auction.messageId);
      console.log("[auction-runtime] Live message updated (caption)", {
        auctionId: auction.id,
        messageId: auction.messageId,
      });
      return;
    } catch (error) {
      const err = error instanceof Error ? error.message : String(error);
      if (err.includes("message is not modified")) return;
      const retryAfterMs = parseRetryAfterMs(err);
      if (retryAfterMs) {
        auctionEditBlockedUntil.set(auction.id, Date.now() + retryAfterMs);
        return;
      }
      if (err.includes("message to edit not found")) {
        shouldCreateNew = true;
      }
    }

    try {
      await bot.editMessageText(caption, editOptions);
      await pinAuctionMessage(bot, auction.channelId, auction.messageId);
      console.log("[auction-runtime] Live message updated (text)", {
        auctionId: auction.id,
        messageId: auction.messageId,
      });
      return;
    } catch (error) {
      const err = error instanceof Error ? error.message : String(error);
      if (err.includes("message is not modified")) return;
      const retryAfterMs = parseRetryAfterMs(err);
      if (retryAfterMs) {
        auctionEditBlockedUntil.set(auction.id, Date.now() + retryAfterMs);
        return;
      }
      if (err.includes("message to edit not found")) {
        shouldCreateNew = true;
      } else if (err.toLowerCase().includes("there is no text in the message to edit")) {
        return;
      } else {
        console.error("[auction-runtime] Failed to edit current auction message", {
          auctionId: auction.id,
          messageId: auction.messageId,
          error: err,
        });
        return;
      }
    }

    if (!shouldCreateNew) {
      return;
    }

    console.error("[auction-runtime] Current auction message missing, creating new one", {
      auctionId: auction.id,
      messageId: auction.messageId,
    });
  }

  const sent = await sendAuctionMessage(bot, auction.channelId, auction, true, false);
  if (!sent.message_id) return;

  await prisma.auction.update({
    where: { id: auction.id },
    data: { messageId: sent.message_id },
  });
  await pinAuctionMessage(bot, auction.channelId, sent.message_id);
  console.log("[auction-runtime] Live message published", {
    auctionId: auction.id,
    messageId: sent.message_id,
  });
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
  await runInAuctionQueue(auctionId, async () => {
    await startAuctionIfDueInternal(prisma, bot, auctionId);
  });
}

async function startAuctionIfDueInternal(prisma: PrismaClient, bot: TelegramBot, auctionId: string): Promise<void> {
  const auction = await prisma.auction.findUnique({
    where: { id: auctionId },
    include: {
      card: true,
      bids: { orderBy: { createdAt: "desc" }, take: 3 },
    },
  });

  if (!auction || auction.status !== "PENDING") return;
  if (auction.startTime && auction.startTime.getTime() > Date.now()) return;
  console.log("[auction-runtime] Starting pending auction", {
    auctionId: auction.id,
    channelId: auction.channelId,
    startTime: auction.startTime?.toISOString() ?? null,
  });

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
  console.log("[auction-runtime] Bid callback received", {
    callbackId: query.id,
    auctionId: auctionId ?? null,
    increment: Number.isNaN(increment) ? null : increment,
    userId: query.from?.id ?? null,
    username: query.from?.username ?? null,
    messageId: query.message?.message_id ?? null,
  });
  if (!auctionId || !BID_INCREMENTS.includes(increment as (typeof BID_INCREMENTS)[number])) {
    console.log("[auction-runtime] Bid callback rejected: invalid payload", {
      callbackId: query.id,
      data: raw,
    });
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
      console.log("[auction-runtime] Bid rejected: auction inactive", {
        callbackId: query.id,
        auctionId,
      });
      await bot.answerCallbackQuery(query.id, { text: "Аукцион уже не активен", show_alert: true });
      return;
    }

    const now = new Date();
    const lastBidTime = current.lastBidAt ?? current.startedAt ?? current.createdAt;
    if (now.getTime() - lastBidTime.getTime() >= current.bidTimeoutMinutes * 60 * 1000) {
      console.log("[auction-runtime] Bid rejected: timeout reached", {
        callbackId: query.id,
        auctionId,
      });
      await finishAuctionInternal(prisma, bot, current.id);
      await bot.answerCallbackQuery(query.id, { text: "Аукцион завершён", show_alert: true });
      return;
    }

    let outbidUser: string | null = null;
    try {
      await prisma.$transaction(async (tx) => {
        await tx.processedBidCallback.create({
          data: {
            callbackId: query.id,
            auctionId,
            bidderTelegramId: String(query.from.id),
            increment,
          },
        });

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
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        console.log("[auction-runtime] Duplicate callback ignored (DB idempotency)", {
          callbackId: query.id,
          auctionId,
          userId: query.from?.id ?? null,
          username: query.from?.username ?? null,
        });
        await bot.answerCallbackQuery(query.id, { text: "Ставка уже обработана" });
        return;
      }
      throw error;
    }

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
    console.log("[auction-runtime] Bid accepted", {
      callbackId: query.id,
      auctionId,
      increment,
      bidderId: query.from?.id ?? null,
      bidderUsername: query.from?.username ?? null,
      newCurrentPrice: updated.currentPrice ?? null,
      outbidUser,
    });

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
        await sendMessageWithRetry(bot, updated.channelId, `⚠️ ${outbidUser}, вашу ставку перебили.`, {
          message_thread_id: AUCTION_TARGET_THREAD_ID,
          dedupKey: `outbid:${query.id}`,
        });
        console.log("[auction-runtime] Outbid notification sent", {
          callbackId: query.id,
          auctionId,
          outbidUser,
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
  await runInAuctionQueue(auctionId, async () => {
    await finishAuctionInternal(prisma, bot, auctionId);
  });
}

async function finishAuctionInternal(prisma: PrismaClient, bot: TelegramBot, auctionId: string): Promise<void> {
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

  const view = mapAuctionView(ended);
  const finalCaption = buildAuctionFinishedCaption(view);
  const finalAnnouncement = buildAuctionFinishedAnnouncement(view);

  await unpinAuctionMessage(bot, ended.channelId, ended.messageId);

  if (ended.messageId) {
    try {
      await bot.editMessageCaption(finalCaption, {
        chat_id: ended.channelId,
        message_id: ended.messageId,
        parse_mode: "HTML",
        message_thread_id: AUCTION_TARGET_THREAD_ID,
        reply_markup: { inline_keyboard: [] },
      });
    } catch (error) {
      const err = error instanceof Error ? error.message : String(error);
      if (!err.includes("message to edit not found")) {
        try {
          await bot.editMessageText(finalCaption, {
            chat_id: ended.channelId,
            message_id: ended.messageId,
            parse_mode: "HTML",
            message_thread_id: AUCTION_TARGET_THREAD_ID,
            reply_markup: { inline_keyboard: [] },
          });
        } catch (fallbackError) {
          console.error("[auction-runtime] Failed to edit ended auction message", {
            auctionId: ended.id,
            messageId: ended.messageId,
            error: fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
          });
        }
      }
    }
  }

  try {
    await sendPhotoWithRetry(bot, ended.channelId, toCoverUrl(ended.card.coverMid), {
      caption: finalAnnouncement,
      parse_mode: "HTML",
      message_thread_id: AUCTION_TARGET_THREAD_ID,
      dedupKey: `auction-finished:${ended.id}`,
    });
  } catch (error) {
    console.error("[auction-runtime] Failed to send finished auction photo, fallback to text", {
      auctionId: ended.id,
      error: error instanceof Error ? error.message : String(error),
    });
    await sendMessageWithRetry(bot, ended.channelId, finalAnnouncement, {
      parse_mode: "HTML",
      message_thread_id: AUCTION_TARGET_THREAD_ID,
      dedupKey: `auction-finished:${ended.id}`,
    });
  }

  console.log("[auction-runtime] Auction finished", {
    auctionId: ended.id,
    channelId: ended.channelId,
    winnerTelegramId: ended.winnerTelegramId,
    finalPrice: ended.currentPrice ?? ended.startPrice ?? 0,
  });
}

export async function cancelAuction(
  prisma: PrismaClient,
  bot: TelegramBot,
  auctionId: string,
  canceledByUsername: string | null,
): Promise<void> {
  await runInAuctionQueue(auctionId, async () => {
    await cancelAuctionInternal(prisma, bot, auctionId, canceledByUsername);
  });
}

async function cancelAuctionInternal(
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

  const byText = canceledByUsername ? `@${canceledByUsername}` : "организатором";
  const cancelText = `⛔️ Аукцион прерван ${byText}.\n🃏 Карта: ${ended.card.cardUrl ?? `https://remanga.org/card/${ended.card.id}`}`;

  if (ended.messageId) {
    try {
      await bot.editMessageCaption(cancelText, {
        chat_id: ended.channelId,
        message_id: ended.messageId,
        parse_mode: "HTML",
        message_thread_id: AUCTION_TARGET_THREAD_ID,
        reply_markup: { inline_keyboard: [] },
      });
      return;
    } catch (error) {
      const err = error instanceof Error ? error.message : String(error);
      if (!err.includes("message to edit not found")) {
        try {
          await bot.editMessageText(cancelText, {
            chat_id: ended.channelId,
            message_id: ended.messageId,
            parse_mode: "HTML",
            message_thread_id: AUCTION_TARGET_THREAD_ID,
            reply_markup: { inline_keyboard: [] },
          });
          return;
        } catch (fallbackError) {
          console.error("[auction-runtime] Failed to edit canceled auction message", {
            auctionId: ended.id,
            messageId: ended.messageId,
            error: fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
          });
        }
      }
    }
  }

  try {
    await sendPhotoWithRetry(bot, ended.channelId, toCoverUrl(ended.card.coverMid), {
      caption: cancelText,
      parse_mode: "HTML",
      message_thread_id: AUCTION_TARGET_THREAD_ID,
    });
  } catch (error) {
    console.error("[auction-runtime] Failed to send canceled auction photo, fallback to text", {
      auctionId: ended.id,
      error: error instanceof Error ? error.message : String(error),
    });
    await sendMessageWithRetry(bot, ended.channelId, cancelText, {
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
  if (due.length > 0) {
    console.log("[auction-runtime] Pending auctions due", { count: due.length });
  }

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
  let expiredCount = 0;
  for (const auction of active) {
    const anchor = auction.lastBidAt ?? auction.startedAt ?? auction.createdAt;
    const timeoutMs = auction.bidTimeoutMinutes * 60 * 1000;
    if (nowMs - anchor.getTime() >= timeoutMs) {
      expiredCount += 1;
      await finishAuction(prisma, bot, auction.id);
    }
  }
  if (expiredCount > 0) {
    console.log("[auction-runtime] Expired auctions finished", { count: expiredCount });
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
    await runInAuctionQueue(auction.id, async () => {
      const blockedUntil = auctionEditBlockedUntil.get(auction.id) ?? 0;
      if (Date.now() < blockedUntil) return;

      const fresh = await prisma.auction.findUnique({
        where: { id: auction.id },
        include: {
          card: true,
          bids: { orderBy: { createdAt: "desc" }, take: 3 },
        },
      });
      if (!fresh || fresh.status !== "ACTIVE") return;

      const remainingMs = getRemainingMs(fresh, Date.now());
      if (remainingMs <= 0) {
        await finishAuctionInternal(prisma, bot, fresh.id);
        return;
      }

      if (!fresh.messageId) {
        await publishLiveMessage(prisma, bot, fresh);
        return;
      }

      const refreshResult = await refreshAuctionMessageCountdown(bot, fresh);
      if (refreshResult.retryAfterMs) {
        auctionEditBlockedUntil.set(fresh.id, Date.now() + refreshResult.retryAfterMs);
        return;
      }

      if (refreshResult.messageMissing) {
        const reset = await prisma.auction.update({
          where: { id: fresh.id },
          data: { messageId: null },
          include: {
            card: true,
            bids: { orderBy: { createdAt: "desc" }, take: 3 },
          },
        });
        await publishLiveMessage(prisma, bot, reset);
      }
    });
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
  }, 5_000);
}
