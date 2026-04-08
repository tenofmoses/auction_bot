import type { CreatedAuctionDetails } from "../services/auctionService.ts";

function formatStartTime(startTime: Date | null): string {
  if (!startTime) return "сразу";
  return startTime.toLocaleString("ru-RU", {
    timeZone: "Europe/Moscow",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }) + " МСК";
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
    "🔔 <b>Аукцион запланирован!</b>",
    "",
    `🧙 Персонаж: ${details.characterName ?? "не указан"}`,
    `📚 Манга: <a href="${mangaUrl}">${details.titleMainName}</a>`,
    `✍️ Автор: <a href="${authorUrl}">${details.authorUsername}</a>`,
    `🃏 Карта: <a href="${details.cardUrl}">${details.cardUrl}</a>`,
    "",
    organizerLine,
    `💰 Стартовая ставка: ${details.startPrice ?? "не указана"}`,
    `⏰ Старт: ${formatStartTime(details.startTime)}`,
  ].join("\n");
}
