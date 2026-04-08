# Auction Bot

Telegram bot for managing auctions of Remanga cards.
Project is written in TypeScript.

## Setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Set up PostgreSQL database and update `DATABASE_URL` in `.env`.

3. Update `AUCTION_CHANNEL_ID` in `.env` with the actual Telegram channel ID.

4. Generate Prisma client:

   ```bash
   npx prisma generate
   ```

5. Run migration:

   ```bash
   npx prisma migrate dev
   ```

6. Run in development mode:

   ```bash
   npm run dev
   ```

7. Build and run production:

   ```bash
   npm run build
   npm start
   ```

## Docker

Run bot + PostgreSQL via Docker Compose:

1. Ensure `.env` contains:
   - `TELEGRAM_BOT_TOKEN`
   - `AUCTION_CHANNEL_ID`

2. Start containers:
   ```bash
   docker compose up -d --build
   ```

3. View logs:
   ```bash
   docker compose logs -f bot
   ```

4. Stop containers:
   ```bash
   docker compose down
   ```

## Usage

Send messages in the auction channel:

- `аукцион https://remanga.org/card/145851` - Start auction with default settings
- `аукцион https://remanga.org/card/145851 300` - Start auction with starting price 300
- `аукцион https://remanga.org/card/145851 14:00` - Start auction at 14:00 MSK

In direct messages with the bot:

- `аукцион` - Show command usage hint
- `аукцион https://remanga.org/card/145851 [300|14:00]` - Works the same as in the auction channel
