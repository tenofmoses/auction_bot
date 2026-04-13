import type { AuctionViewDetails, CreatedAuctionDetails, RecentBid } from "../types/auction.js";

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

function formatUserName(telegramId: string | null, telegramUsername: string | null): string {
  if (telegramUsername) {
    return `@${telegramUsername}`;
  }
  if (telegramId) {
    return `user_${telegramId}`;
  }
  return "неизвестно";
}

function formatBidLine(bid: RecentBid, index: number): string {
  const bidder = formatUserName(bid.bidderTelegramId, bid.bidderTelegramUsername);
  return `${index + 1}. ${bidder} — ${bid.totalPrice}`;
}

function formatTimeLeft(remainingMs: number): string {
  const safeMs = Math.max(0, remainingMs);
  const totalSeconds = Math.floor(safeMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) return `${hours} ч ${minutes} мин ${seconds} сек`;
  if (minutes > 0) return `${minutes} мин ${seconds} сек`;
  return `${seconds} сек`;
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

export function buildAuctionLiveCaption(
  details: AuctionViewDetails,
  outbidUser: string | null = null,
  remainingMs: number | null = null,
): string {
  const mangaUrl = `https://remanga.org/manga/${details.titleDir}/main`;
  const authorUrl = `https://remanga.org/user/${details.authorUsername}/about`;
  const winner = formatUserName(details.winnerTelegramId, details.winnerTelegramUsername);
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
    `⏱️ До конца аукциона: ${formatTimeLeft(remainingMs ?? 0)}`,
    outbidUser ? `⚠️ ${outbidUser}, вашу ставку перебили` : null,
    "",
    "📝 Последние 3 ставки:",
    lastBidsBlock,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

export function buildAuctionFinishedCaption(details: AuctionViewDetails): string {
  const winner = formatUserName(details.winnerTelegramId, details.winnerTelegramUsername);
  return [
    buildAuctionLiveCaption({ ...details, status: "ENDED" }),
    "",
    `✅ Победитель: ${details.lastBids.length > 0 ? winner : "нет ставок"}`,
  ].join("\n");
}
