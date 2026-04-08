import { PrismaClient } from '@prisma/client';
import TelegramBot from 'node-telegram-bot-api';
import { config } from './config.ts';
import { registerMessageHandler } from './handlers/messageHandler.ts';

const prisma = new PrismaClient({
  datasources: {
    db: {
      url: config.DATABASE_URL,
    },
  },
});

const bot = new TelegramBot(config.TELEGRAM_BOT_TOKEN, { polling: true });
registerMessageHandler(bot, prisma, config);

console.log('Bot is running...');
