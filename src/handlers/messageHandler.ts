import type { PrismaClient } from "@prisma/client";
import type TelegramBot from "node-telegram-bot-api";
import type { AppConfig } from "../config.ts";
import { createAuction, parseAuctionCommand } from "../services/auctionService.ts";
import { buildAuctionPlannedMessage } from "./messageBuilders.ts";

export function registerMessageHandler(bot: TelegramBot, prisma: PrismaClient, cfg: AppConfig): void {
  bot.on("message", async (msg) => {
    const chatId = msg.chat.id;
    const chatType = msg.chat.type;
    const text = msg.text;
    const normalizedText = text?.trim();
    const isAuctionChannel = chatId.toString() === cfg.AUCTION_CHANNEL_ID;
    const isPrivateChat = chatType === "private";

    if (!isAuctionChannel && !isPrivateChat) return;

    if (isPrivateChat && normalizedText?.toLowerCase() === "аукцион") {
      await bot.sendMessage(chatId, "Отправь команду в формате:\nаукцион https://remanga.org/card/145851 [цена|время]");
      return;
    }

    if (!normalizedText || !normalizedText.toLowerCase().startsWith("аукцион ")) return;

    const command = parseAuctionCommand(normalizedText);
    if (!command) return;

    try {
      const auctionDetails = await createAuction(prisma, command, cfg.AUCTION_CHANNEL_ID, {
        telegramId: msg.from?.id ? String(msg.from.id) : null,
        telegramUsername: msg.from?.username ?? null,
      });
      await bot.sendMessage(chatId, buildAuctionPlannedMessage(auctionDetails), {
        parse_mode: "HTML",
      });
    } catch (error) {
      console.error(error);
      await bot.sendMessage(chatId, "Ошибка при создании аукциона");
    }
  });
}
