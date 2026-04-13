import { PrismaClient } from "@prisma/client";
import TelegramBot from "node-telegram-bot-api";
import { config } from "./config.js";
import { registerMessageHandler } from "./handlers/messageHandler.js";
import { initAuctionRuntime } from "./services/auctionRuntimeService.js";

const prisma = new PrismaClient({
  datasources: {
    db: {
      url: config.DATABASE_URL,
    },
  },
});

const bot = new TelegramBot(config.TELEGRAM_BOT_TOKEN, { polling: true });

bot.on("polling_error", (error) => {
  console.error("Polling error:", error?.message ?? error);
});

bot.on("error", (error) => {
  console.error("Telegram bot error:", error?.message ?? error);
});

void bot
  .getMe()
  .then((me) => {
    console.log("[bot] Telegram identity loaded", {
      id: me.id,
      username: me.username,
      canJoinGroups: me.can_join_groups,
      canReadAllGroupMessages: me.can_read_all_group_messages,
    });
  })
  .catch((error) => {
    console.error("[bot] Failed to fetch bot identity:", error?.message ?? error);
  });

registerMessageHandler(bot, prisma, config);
initAuctionRuntime(prisma, bot);

console.log("[bot] Bot is running...", {
  auctionChannelId: config.AUCTION_CHANNEL_ID,
});
