import 'dotenv/config';

function getRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function getOptionalEnv(name: string, defaultValue: string): string {
  return process.env[name] || defaultValue;
}

export type AppConfig = {
  TELEGRAM_BOT_TOKEN: string;
  DATABASE_URL: string;
  AUCTION_CHANNEL_ID: string;
};

export const config: AppConfig = {
  TELEGRAM_BOT_TOKEN: getRequiredEnv('TELEGRAM_BOT_TOKEN'),
  DATABASE_URL: getRequiredEnv('DATABASE_URL'),
  AUCTION_CHANNEL_ID: getOptionalEnv('AUCTION_CHANNEL_ID', '-1001234567890'),
};
