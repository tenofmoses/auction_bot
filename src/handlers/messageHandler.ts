import type { PrismaClient } from "@prisma/client";
import type TelegramBot from "node-telegram-bot-api";
import type { AppConfig } from "../types/app.js";
import { createAuction, parseAuctionCommand } from "../services/auctionService.js";
import { buildAuctionPlannedMessage } from "./messageBuilders.js";
import { cancelAuction, handleBidCallback, startAuctionIfDue } from "../services/auctionRuntimeService.js";

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
      await bot.answerCallbackQuery(query.id, {
        text: "Не удалось обработать ставку",
        show_alert: true,
      });
    }
  });

  bot.on("message", async (msg) => {
    const chatId = msg.chat.id;
    const chatType = msg.chat.type;
    const messageThreadId = msg.message_thread_id ?? null;
    const text = msg.text;
    const normalizedText = text?.trim();
    const isTargetThread =
      chatId.toString() === AUCTION_TARGET_CHAT_ID && messageThreadId === AUCTION_TARGET_THREAD_ID;
    const isPrivateChat = chatType === "private";

    if (!isTargetThread && !isPrivateChat) {
      return;
    }

    console.log("[message] Received update", {
      messageId: msg.message_id ?? null,
      messageThreadId,
      replyToMessageId: msg.reply_to_message?.message_id ?? null,
      chatId,
      chatType,
      userId: msg.from?.id ?? null,
      username: msg.from?.username ?? null,
      text: normalizedText ?? null,
      isTargetThread,
      isPrivateChat,
    });

    const repliedMessageId = msg.reply_to_message?.message_id ?? null;
    const sender = msg.from;
    if (repliedMessageId && sender?.id) {
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

      if (!replyAuction && normalizedText?.toLowerCase() === "стоп") {
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
          await bot.sendMessage(AUCTION_TARGET_CHAT_ID, "Только организатор может прервать этот аукцион.", targetThreadOptions());
          return;
        }

        if (normalizedText?.toLowerCase() !== "стоп") {
          await bot.sendMessage(
            AUCTION_TARGET_CHAT_ID,
            "Чтобы прервать аукцион, ответь на сообщение аукциона словом: стоп",
            targetThreadOptions(),
          );
          return;
        }

        await cancelAuction(prisma, bot, replyAuction.id, sender.username ?? null);
        return;
      }

      if (normalizedText?.toLowerCase() === "стоп") {
        await bot.sendMessage(AUCTION_TARGET_CHAT_ID, "Не нашел активный или запланированный аукцион для остановки.", targetThreadOptions());
        return;
      }
    }

    if (normalizedText?.toLowerCase() === "/start" || normalizedText?.toLowerCase() === "/help" || normalizedText?.toLowerCase() === "аукцион") {
      await bot.sendMessage(AUCTION_TARGET_CHAT_ID, buildAuctionRulesMessage(), {
        parse_mode: "HTML",
        ...targetThreadOptions(),
      });
      return;
    }

    if (!normalizedText || !normalizedText.toLowerCase().startsWith("аукцион ")) {
      console.log("[message] Ignored: text does not match command format", {
        chatId,
        text: normalizedText ?? null,
      });
      return;
    }

    const command = parseAuctionCommand(normalizedText);
    if (!command) {
      await bot.sendMessage(
        AUCTION_TARGET_CHAT_ID,
        "Не удалось разобрать команду.\nФормат: аукцион https://remanga.org/card/145851 [цена|время]",
        targetThreadOptions(),
      );
      return;
    }

    try {
      const auctionDetails = await createAuction(
        prisma,
        command,
        AUCTION_TARGET_CHAT_ID,
        {
          telegramId: msg.from?.id ? String(msg.from.id) : null,
          telegramUsername: msg.from?.username ?? null,
        },
      );

      const isFutureStart = Boolean(
        auctionDetails.startTime && auctionDetails.startTime.getTime() > Date.now(),
      );

      if (isFutureStart) {
        const plannedText = buildAuctionPlannedMessage(auctionDetails);
        try {
          const sent = await bot.sendPhoto(AUCTION_TARGET_CHAT_ID, toCoverUrl(auctionDetails.coverMid), {
            caption: plannedText,
            parse_mode: "HTML",
            ...targetThreadOptions(),
          });
          if (sent.message_id) {
            await prisma.auction.update({
              where: { id: auctionDetails.auctionId },
              data: { messageId: sent.message_id },
            });
          }
        } catch {
          const sent = await bot.sendMessage(AUCTION_TARGET_CHAT_ID, plannedText, {
            parse_mode: "HTML",
            ...targetThreadOptions(),
          });
          if (sent.message_id) {
            await prisma.auction.update({
              where: { id: auctionDetails.auctionId },
              data: { messageId: sent.message_id },
            });
          }
        }
        return;
      }

      await startAuctionIfDue(prisma, bot, auctionDetails.auctionId);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error("[message] Failed to create auction", {
        chatId,
        text: normalizedText,
        error: errorMessage,
      });

      await bot.sendMessage(AUCTION_TARGET_CHAT_ID, "Ошибка при создании аукциона", targetThreadOptions());
    }
  });
}
