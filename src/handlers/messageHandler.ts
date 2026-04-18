import type { PrismaClient } from "@prisma/client";
import type TelegramBot from "node-telegram-bot-api";
import type { AppConfig } from "../types/app.js";
import { createAuction, parseAuctionCommand } from "../services/auctionService.js";
import { buildAuctionPlannedMessage } from "./messageBuilders.js";
import { cancelAuction, handleBidCallback, startAuctionIfDue } from "../services/auctionRuntimeService.js";
import { sendMessageWithRetry, sendPhotoWithRetry } from "../services/telegramDeliveryService.js";

const AUCTION_TARGET_CHAT_ID = "-1002265261405";
const AUCTION_TARGET_THREAD_ID = 1273810;

function toCoverUrl(coverMid: string): string {
  if (coverMid.startsWith("https://") || coverMid.startsWith("http://")) return coverMid;
  if (coverMid.startsWith("//")) return `https:${coverMid}`;
  if (coverMid.startsWith("/")) return `https://api.remanga.org${coverMid}`;
  return `https://${coverMid}`;
}

function buildAuctionRulesMessage(): string {
  return [
    "📌 <b>Правила аукциона</b>",
    "",
    "1. <b>Как запустить аукцион</b>",
    "Отправь: <code>аукцион https://remanga.org/card/145851 [цена] [HH:mm] [длительность]</code>",
    "Пример: <code>аукцион https://remanga.org/card/145851 500 22:30 30m</code>",
    "Длительность: <code>30m</code>, <code>2h</code>, <code>30м</code>, <code>2ч</code> (по умолчанию 60 минут).",
    "",
    "2. <b>Как остановить аукцион</b>",
    "Организатор должен ответить на сообщение аукциона словом <b>стоп</b>.",
    "",
    "3. <b>Как поставить ставку</b>",
    "Нажми кнопку +50 / +100 / +500 / +1000 под сообщением аукциона.",
    "",
    "4. <b>Когда аукцион завершается</b>",
    "Если в течение указанного времени после последней ставки не было новых ставок, аукцион завершается автоматически.",
  ].join("\n");
}

function targetThreadOptions() {
  return { message_thread_id: AUCTION_TARGET_THREAD_ID };
}

async function pinAuctionMessage(bot: TelegramBot, messageId: number): Promise<void> {
  try {
    await bot.pinChatMessage(AUCTION_TARGET_CHAT_ID, messageId, { disable_notification: true });
  } catch (error) {
    console.error("[message] Failed to pin auction message", {
      messageId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export function registerMessageHandler(bot: TelegramBot, prisma: PrismaClient, _cfg: AppConfig): void {
  bot.on("callback_query", async (query) => {
    try {
      await handleBidCallback(prisma, bot, query);
    } catch (error) {
      console.error("[callback] Failed to process bid callback", {
        data: query.data ?? null,
        from: query.from?.id ?? null,
        error: error instanceof Error ? error.message : String(error),
      });
      try {
        await bot.answerCallbackQuery(query.id, {
          text: "Не удалось обработать ставку",
          show_alert: true,
        });
      } catch {
        // Ignore callback answer failures (too old/already answered).
      }
    }
  });

  bot.on("message", async (msg) => {
    const chatId = msg.chat.id;
    const chatType = msg.chat.type;
    const messageThreadId = msg.message_thread_id ?? null;
    const text = msg.text;
    const normalizedText = text?.trim();
    const isTargetThread = chatId.toString() === AUCTION_TARGET_CHAT_ID && messageThreadId === AUCTION_TARGET_THREAD_ID;
    const isPrivateChat = chatType === "private";

    if (!isTargetThread && !isPrivateChat) {
      return;
    }

    console.log("[message] Received update", {
      username: msg.from?.username ?? null,
      text: normalizedText ?? null,
    });

    const repliedMessageId = msg.reply_to_message?.message_id ?? null;
    const sender = msg.from;
    const isStopCommand = normalizedText?.toLowerCase() === "стоп";
    if (repliedMessageId && sender?.id && isStopCommand) {
      console.log("[message] Stop command received", {
        replyToMessageId: repliedMessageId,
        senderUsername: sender.username ?? null,
      });
      let replyAuction = await prisma.auction.findFirst({
        where: {
          channelId: AUCTION_TARGET_CHAT_ID,
          messageId: repliedMessageId,
          status: { in: ["PENDING", "ACTIVE"] },
        },
        select: {
          id: true,
          starterTelegramId: true,
          starterTelegramUsername: true,
        },
      });

      if (!replyAuction) {
        replyAuction = await prisma.auction.findFirst({
          where: {
            channelId: AUCTION_TARGET_CHAT_ID,
            status: { in: ["PENDING", "ACTIVE"] },
            OR: [
              { starterTelegramId: String(sender.id) },
              sender.username ? { starterTelegramUsername: sender.username } : undefined,
            ].filter(Boolean) as Array<{ starterTelegramId?: string; starterTelegramUsername?: string }>,
          },
          select: {
            id: true,
            starterTelegramId: true,
            starterTelegramUsername: true,
          },
          orderBy: { createdAt: "desc" },
        });
      }

      if (replyAuction) {
        const senderId = String(sender.id);
        const senderUsername = sender.username?.toLowerCase() ?? null;
        const organizerId = replyAuction.starterTelegramId;
        const organizerUsername = replyAuction.starterTelegramUsername?.toLowerCase() ?? null;
        const isOrganizer = organizerId
          ? organizerId === senderId
          : Boolean(organizerUsername && senderUsername && organizerUsername === senderUsername);

        if (!isOrganizer) {
          console.log("[message] Stop command ignored: not organizer", {
            auctionId: replyAuction.id,
            senderUsername,
          });
          return;
        }

        console.log("[message] Stop command accepted", {
          auctionId: replyAuction.id,
          senderUsername,
        });
        await cancelAuction(prisma, bot, replyAuction.id, sender.username ?? null);
        return;
      }

      console.log("[message] Stop command ignored: auction not found for reply", {
        replyToMessageId: repliedMessageId,
        senderId: sender.id,
      });
    }

    if (
      normalizedText?.toLowerCase() === "/start" ||
      normalizedText?.toLowerCase() === "/help" ||
      normalizedText?.toLowerCase() === "аукцион"
    ) {
      console.log("[message] Sending auction rules");
      await sendMessageWithRetry(bot, AUCTION_TARGET_CHAT_ID, buildAuctionRulesMessage(), {
        parse_mode: "HTML",
        sourceMessageId: msg.message_id ?? null,
        ...targetThreadOptions(),
      });
      return;
    }

    if (!normalizedText || !normalizedText.toLowerCase().startsWith("аукцион ")) {
      console.log("[message] Unsupported command format", {
        text: normalizedText ?? null,
      });
      return;
    }

    const command = parseAuctionCommand(normalizedText);
    if (!command) {
      console.log("[message] Auction command parse failed", {
        messageId: msg.message_id ?? null,
        text: normalizedText,
      });
      await sendMessageWithRetry(
        bot,
        AUCTION_TARGET_CHAT_ID,
        "Не удалось разобрать команду.\nФормат: аукцион https://remanga.org/card/145851 [цена|время]",
        {
          sourceMessageId: msg.message_id ?? null,
          ...targetThreadOptions(),
        },
      );
      return;
    }

    try {
      const auctionDetails = await createAuction(prisma, command, AUCTION_TARGET_CHAT_ID, {
        telegramId: msg.from?.id ? String(msg.from.id) : null,
        telegramUsername: msg.from?.username ?? null,
      });

      const isFutureStart = Boolean(auctionDetails.startTime && auctionDetails.startTime.getTime() > Date.now());
      console.log("[message] Auction created successfully", {
        auctionId: auctionDetails.auctionId,
        cardUrl: auctionDetails.cardUrl,
        isFutureStart,
        chatId: AUCTION_TARGET_CHAT_ID,
        threadId: AUCTION_TARGET_THREAD_ID,
        senderUsername: msg.from?.username ?? null,
      });

      if (isFutureStart) {
        const plannedText = buildAuctionPlannedMessage(auctionDetails);
        try {
          const sent = await sendPhotoWithRetry(bot, AUCTION_TARGET_CHAT_ID, toCoverUrl(auctionDetails.coverMid), {
            caption: plannedText,
            parse_mode: "HTML",
            sourceMessageId: msg.message_id ?? null,
            ...targetThreadOptions(),
          });
          if (sent.message_id) {
            await prisma.auction.update({
              where: { id: auctionDetails.auctionId },
              data: { messageId: sent.message_id },
            });
            await pinAuctionMessage(bot, sent.message_id);
            console.log("[message] Planned auction message published (photo)");
          }
        } catch {
          const sent = await sendMessageWithRetry(bot, AUCTION_TARGET_CHAT_ID, plannedText, {
            parse_mode: "HTML",
            sourceMessageId: msg.message_id ?? null,
            ...targetThreadOptions(),
          });
          if (sent.message_id) {
            await prisma.auction.update({
              where: { id: auctionDetails.auctionId },
              data: { messageId: sent.message_id },
            });
            await pinAuctionMessage(bot, sent.message_id);
            console.log("[message] Planned auction message published (text fallback)", {
              auctionId: auctionDetails.auctionId,
            });
          }
        }
        return;
      }

      console.log("[message] Starting auction immediately");
      await startAuctionIfDue(prisma, bot, auctionDetails.auctionId);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error("[message] Failed to create auction", {
        chatId,
        text: normalizedText,
        error: errorMessage,
      });

      await sendMessageWithRetry(bot, AUCTION_TARGET_CHAT_ID, "Ошибка при создании аукциона", {
        sourceMessageId: msg.message_id ?? null,
        ...targetThreadOptions(),
      });
    }
  });
}
