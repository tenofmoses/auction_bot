import type { PrismaClient } from "@prisma/client";
import type TelegramBot from "node-telegram-bot-api";
import type { AppConfig } from "../types/app.js";
import { createAuction, parseAuctionCommand } from "../services/auctionService.js";
import { buildAuctionPlannedMessage } from "./messageBuilders.js";
import { cancelAuction, handleBidCallback, startAuctionIfDue } from "../services/auctionRuntimeService.js";

function toCoverUrl(coverMid: string): string {
  if (coverMid.startsWith("https://") || coverMid.startsWith("http://")) return coverMid;
  if (coverMid.startsWith("//")) return `https:${coverMid}`;
  if (coverMid.startsWith("/")) return `https://api.remanga.org${coverMid}`;
  return `https://${coverMid}`;
}

export function registerMessageHandler(bot: TelegramBot, prisma: PrismaClient, cfg: AppConfig): void {
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
    const text = msg.text;
    const normalizedText = text?.trim();
    const isAuctionChannel = chatId.toString() === cfg.AUCTION_CHANNEL_ID;
    const isPrivateChat = chatType === "private";

    console.log("[message] Received update", {
      messageId: msg.message_id ?? null,
      messageThreadId: msg.message_thread_id ?? null,
      replyToMessageId: msg.reply_to_message?.message_id ?? null,
      chatId,
      chatType,
      userId: msg.from?.id ?? null,
      username: msg.from?.username ?? null,
      text: normalizedText ?? null,
      isAuctionChannel,
      isPrivateChat,
    });

    if (!isAuctionChannel && !isPrivateChat) {
      console.log("[message] Ignored: unsupported chat type/channel", {
        chatId,
        chatType,
      });
      return;
    }

    const repliedMessageId = msg.reply_to_message?.message_id ?? null;
    if (repliedMessageId && msg.from?.id) {
      const replyAuction = await prisma.auction.findFirst({
        where: {
          channelId: String(chatId),
          messageId: repliedMessageId,
          status: { in: ["PENDING", "ACTIVE"] },
        },
        select: {
          id: true,
          starterTelegramId: true,
          starterTelegramUsername: true,
        },
      });

      if (replyAuction) {
        const senderId = String(msg.from.id);
        const senderUsername = msg.from.username?.toLowerCase() ?? null;
        const organizerId = replyAuction.starterTelegramId;
        const organizerUsername = replyAuction.starterTelegramUsername?.toLowerCase() ?? null;
        const isOrganizer = organizerId
          ? organizerId === senderId
          : Boolean(organizerUsername && senderUsername && organizerUsername === senderUsername);

        if (!isOrganizer) {
          await bot.sendMessage(chatId, "Только организатор может прервать этот аукцион.");
          return;
        }

        if (normalizedText?.toLowerCase() !== "стоп") {
          await bot.sendMessage(chatId, "Чтобы прервать аукцион, ответь на сообщение аукциона словом: стоп");
          return;
        }

        await cancelAuction(prisma, bot, replyAuction.id, msg.from.username ?? null);
        return;
      }
    }

    if (
      isPrivateChat &&
      (normalizedText?.toLowerCase() === "/start" || normalizedText?.toLowerCase() === "/help")
    ) {
      console.log("[message] Sending private help for /start or /help", {
        chatId,
      });
      await bot.sendMessage(chatId, "Привет. Отправь команду в формате:\nаукцион https://remanga.org/card/145851 [цена|время]");
      return;
    }

    if (isPrivateChat && normalizedText?.toLowerCase() === "аукцион") {
      console.log("[message] Sending private help for 'аукцион'", {
        chatId,
      });
      await bot.sendMessage(chatId, "Отправь команду в формате:\nаукцион https://remanga.org/card/145851 [цена|время]");
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
      console.log("[message] Failed to parse auction command", {
        chatId,
        text: normalizedText,
      });
      if (isPrivateChat) {
        await bot.sendMessage(chatId, "Не удалось разобрать команду.\nФормат: аукцион https://remanga.org/card/145851 [цена|время]");
      }
      return;
    }

    console.log("[message] Parsed auction command", {
      chatId,
      cardId: command.cardId,
      startPrice: command.startPrice,
      startTime: command.startTime ? command.startTime.toISOString() : null,
    });

    try {
      const targetAuctionChatId = isPrivateChat ? String(chatId) : cfg.AUCTION_CHANNEL_ID;
      const auctionDetails = await createAuction(prisma, command, targetAuctionChatId, {
        telegramId: msg.from?.id ? String(msg.from.id) : null,
        telegramUsername: msg.from?.username ?? null,
      });
      console.log("[message] Auction created successfully", {
        auctionId: auctionDetails.auctionId,
        chatId,
        cardUrl: auctionDetails.cardUrl,
        titleDir: auctionDetails.titleDir,
      });

      const isFutureStart = Boolean(
        auctionDetails.startTime && auctionDetails.startTime.getTime() > Date.now(),
      );

      if (isFutureStart) {
        const plannedText = buildAuctionPlannedMessage(auctionDetails);
        try {
          const sent = await bot.sendPhoto(chatId, toCoverUrl(auctionDetails.coverMid), {
            caption: plannedText,
            parse_mode: "HTML",
          });
          if (sent.message_id) {
            await prisma.auction.update({
              where: { id: auctionDetails.auctionId },
              data: { messageId: sent.message_id },
            });
          }
        } catch (photoError) {
          console.error("[message] Failed to send planned auction photo, fallback to text", {
            auctionId: auctionDetails.auctionId,
            chatId,
            error: photoError instanceof Error ? photoError.message : String(photoError),
          });
          const sent = await bot.sendMessage(chatId, plannedText, {
            parse_mode: "HTML",
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

      try {
        await startAuctionIfDue(prisma, bot, auctionDetails.auctionId);
        if (isPrivateChat) {
          await bot.sendMessage(chatId, "Аукцион запущен.");
        }
      } catch (publishError) {
        console.error("[message] Failed to publish auction to channel", {
          auctionId: auctionDetails.auctionId,
          channelId: targetAuctionChatId,
          error: publishError instanceof Error ? publishError.message : String(publishError),
        });

        if (isPrivateChat) {
          await bot.sendMessage(
            chatId,
            [
              "Аукцион создан, но не удалось опубликовать его в чат.",
              `Целевой chat_id: ${targetAuctionChatId}.`,
              "Проверь права бота и корректность chat_id.",
            ].join("\n"),
          );
        }
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error("[message] Failed to create auction", {
        chatId,
        text: normalizedText,
        error: errorMessage,
      });

      await bot.sendMessage(chatId, "Ошибка при создании аукциона");
    }
  });
}
