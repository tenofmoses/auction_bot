import type { PrismaClient } from "@prisma/client";
import type TelegramBot from "node-telegram-bot-api";
import type { AppConfig } from "../config.js";
import { createAuction, parseAuctionCommand } from "../services/auctionService.js";
import { buildAuctionPlannedMessage } from "./messageBuilders.js";

export function registerMessageHandler(bot: TelegramBot, prisma: PrismaClient, cfg: AppConfig): void {
  bot.on("message", async (msg) => {
    const chatId = msg.chat.id;
    const chatType = msg.chat.type;
    const text = msg.text;
    const normalizedText = text?.trim();
    const isAuctionChannel = chatId.toString() === cfg.AUCTION_CHANNEL_ID;
    const isPrivateChat = chatType === "private";

    console.log("[message] Received update", {
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
      const auctionDetails = await createAuction(prisma, command, cfg.AUCTION_CHANNEL_ID, {
        telegramId: msg.from?.id ? String(msg.from.id) : null,
        telegramUsername: msg.from?.username ?? null,
      });
      console.log("[message] Auction created successfully", {
        chatId,
        cardUrl: auctionDetails.cardUrl,
        titleDir: auctionDetails.titleDir,
      });
      await bot.sendMessage(chatId, buildAuctionPlannedMessage(auctionDetails), {
        parse_mode: "HTML",
      });
    } catch (error) {
      console.error("[message] Failed to create auction", {
        chatId,
        text: normalizedText,
        error: error instanceof Error ? error.message : String(error),
      });
      await bot.sendMessage(chatId, "Ошибка при создании аукциона");
    }
  });
}
