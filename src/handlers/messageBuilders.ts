import type { Bid } from "@prisma/client";
import type { CreatedAuctionDetails } from "../services/auctionService.js";

export type AuctionViewDetails = {
  characterName: string | null;
  titleMainName: string;
  titleDir: string;
  authorUsername: string;
  cardUrl: string;
  currentPrice: number;
  winnerTelegramId: string | null;
  winnerTelegramUsername: string | null;
  status: "ACTIVE" | "ENDED";
  lastBids: Pick<Bid, "bidderTelegramId" | "bidderTelegramUsername" | "totalPrice" | "createdAt">[];
};

function formatStartTime(startTime: Date | null): string {
  if (!startTime) return "сразу";
  return `${startTime.toLocaleString("ru-RU", {
    timeZone: "Europe/Moscow",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  })} МСК`;
}

function buildUserLink(telegramId: string | null, telegramUsername: string | null): string {
  if (telegramUsername) {
    return `<a href="https://t.me/${telegramUsername}">@${telegramUsername}</a>`;
  }
  if (telegramId) {
    return `<a href="tg://user?id=${telegramId}">user_${telegramId}</a>`;
  }
  return "неизвестно";
}

function formatBidLine(
  bid: Pick<Bid, "bidderTelegramId" | "bidderTelegramUsername" | "totalPrice" | "createdAt">,
  index: number,
): string {
  const bidder = buildUserLink(bid.bidderTelegramId, bid.bidderTelegramUsername);
  return `${index + 1}. ${bidder} — ${bid.totalPrice}`;
}

export function buildAuctionPlannedMessage(details: CreatedAuctionDetails): string {
  const mangaUrl = `https://remanga.org/manga/${details.titleDir}/main`;
  const authorUrl = `https://remanga.org/user/${details.authorUsername}/about`;
  const organizerText = details.starterTelegramUsername
    ? `@${details.starterTelegramUsername}`
    : "организатор";
  const organizerUrl = details.starterTelegramUsername
    ? `https://t.me/${details.starterTelegramUsername}`
    : details.starterTelegramId
      ? `tg://user?id=${details.starterTelegramId}`
      : "";

  const organizerLine = organizerUrl
    ? `👤 Организатор: <a href="${organizerUrl}">${organizerText}</a>`
    : `👤 Организатор: ${organizerText}`;

  return [
    "🔔 <b>Аукцион запланирован</b>",
    "",
    `🧙 Персонаж: ${details.characterName ?? "не указан"}`,
    `📚 Манга: <a href="${mangaUrl}">${details.titleMainName}</a>`,
    `✍️ Автор: <a href="${authorUrl}">${details.authorUsername}</a>`,
    `🃏 Карта: <a href="${details.cardUrl}">ссылка</a>`,
    "",
    organizerLine,
    `💰 Стартовая ставка: ${details.startPrice ?? 0}`,
    `⏰ Старт: ${formatStartTime(details.startTime)}`,
  ].join("\n");
}

export function buildAuctionLiveCaption(details: AuctionViewDetails): string {
  const mangaUrl = `https://remanga.org/manga/${details.titleDir}/main`;
  const authorUrl = `https://remanga.org/user/${details.authorUsername}/about`;
  const winner = buildUserLink(details.winnerTelegramId, details.winnerTelegramUsername);
  const hasBids = details.lastBids.length > 0;
  const lastBidsBlock = hasBids
    ? details.lastBids.map((bid, index) => formatBidLine(bid, index)).join("\n")
    : "Ставок пока нет";

  return [
    `🔥 <b>Аукцион ${details.status === "ENDED" ? "завершён" : "идёт"}</b>`,
    "",
    `🧙 Персонаж: ${details.characterName ?? "не указан"}`,
    `📚 Манга: <a href="${mangaUrl}">${details.titleMainName}</a>`,
    `✍️ Автор: <a href="${authorUrl}">${details.authorUsername}</a>`,
    `🃏 Карта: <a href="${details.cardUrl}">ссылка</a>`,
    "",
    `💸 Текущий выкуп: <b>${details.currentPrice}</b>`,
    `🏆 Лидер: ${hasBids ? winner : "пока нет"}`,
    "",
    "📝 Последние 3 ставки:",
    lastBidsBlock,
  ].join("\n");
}

export function buildAuctionFinishedCaption(details: AuctionViewDetails): string {
  const winner = buildUserLink(details.winnerTelegramId, details.winnerTelegramUsername);
  return [
    buildAuctionLiveCaption({ ...details, status: "ENDED" }),
    "",
    `✅ Победитель: ${details.lastBids.length > 0 ? winner : "нет ставок"}`,
  ].join("\n");
}
