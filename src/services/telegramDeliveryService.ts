import type TelegramBot from "node-telegram-bot-api";
import type { Message, SendMessageOptions, SendPhotoOptions } from "node-telegram-bot-api";

const SEND_ATTEMPTS = 4;
const BASE_RETRY_DELAY_MS = 700;
const DEDUP_TTL_MS = 60_000;

const sendQueues = new Map<string, Promise<unknown>>();
const dedupCache = new Map<string, { message: Message; expiresAt: number }>();

type DeliveryOptions = {
  sourceMessageId?: number | null;
  dedupKey?: string;
};

type ReliableSendMessageOptions = SendMessageOptions & DeliveryOptions;
type ReliableSendPhotoOptions = (SendPhotoOptions & { caption: string }) & DeliveryOptions;

function queueKey(chatId: string | number, threadId?: number): string {
  return `${String(chatId)}:${threadId ?? 0}`;
}

function cleanupDedupCache(now: number): void {
  for (const [key, entry] of dedupCache.entries()) {
    if (entry.expiresAt <= now) {
      dedupCache.delete(key);
    }
  }
}

function buildDedupKey(
  kind: "message" | "photo",
  chatId: string | number,
  threadId: number | undefined,
  sourceMessageId: number | null | undefined,
  explicitDedupKey: string | undefined,
): string | null {
  if (explicitDedupKey) {
    return `${kind}:${String(chatId)}:${threadId ?? 0}:${explicitDedupKey}`;
  }
  if (!sourceMessageId) return null;
  return `${kind}:${String(chatId)}:${threadId ?? 0}:${sourceMessageId}`;
}

async function runInSendQueue<T>(
  chatId: string | number,
  threadId: number | undefined,
  task: () => Promise<T>,
): Promise<T> {
  const key = queueKey(chatId, threadId);
  const previous = sendQueues.get(key) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(task);
  sendQueues.set(key, current);
  try {
    return await current;
  } finally {
    if (sendQueues.get(key) === current) {
      sendQueues.delete(key);
    }
  }
}

function parseRetryAfterMs(errorText: string): number | null {
  const match = errorText.match(/retry after\s+(\d+)/i);
  if (!match) return null;
  const seconds = Number(match[1]);
  if (Number.isNaN(seconds) || seconds <= 0) return null;
  return seconds * 1000;
}

function parseTelegramStatusCode(errorText: string): number | null {
  const match = errorText.match(/ETELEGRAM:\s*(\d{3})/i);
  if (!match) return null;
  const code = Number(match[1]);
  if (Number.isNaN(code)) return null;
  return code;
}

function isRetryableError(error: unknown): boolean {
  const anyError = error as { code?: string; message?: string };
  const message = anyError?.message ?? String(error);
  const statusCode = parseTelegramStatusCode(message);

  if (statusCode === 429) return true;
  if (statusCode && statusCode >= 500) return true;

  if (message.includes("EFATAL: AggregateError")) return true;

  const code = anyError?.code ?? "";
  const networkCodes = new Set([
    "EFATAL",
    "ETIMEDOUT",
    "ESOCKETTIMEDOUT",
    "ECONNRESET",
    "ECONNABORTED",
    "ENOTFOUND",
    "EAI_AGAIN",
    "EPIPE",
  ]);
  if (networkCodes.has(code)) return true;

  const lower = message.toLowerCase();
  if (lower.includes("network")) return true;
  if (lower.includes("socket hang up")) return true;

  return false;
}

function retryDelayMs(error: unknown, attempt: number): number {
  const message = error instanceof Error ? error.message : String(error);
  const retryAfterMs = parseRetryAfterMs(message);
  if (retryAfterMs) return retryAfterMs;
  return BASE_RETRY_DELAY_MS * attempt;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function performWithRetry<T>(operation: () => Promise<T>): Promise<T> {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= SEND_ATTEMPTS; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      const retryable = isRetryableError(error);
      if (!retryable || attempt >= SEND_ATTEMPTS) {
        throw error;
      }
      await sleep(retryDelayMs(error, attempt));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError ?? "send failed"));
}

export async function sendMessageWithRetry(
  bot: TelegramBot,
  chatId: string | number,
  text: string,
  options: ReliableSendMessageOptions = {},
): Promise<Message> {
  const dedupKey = buildDedupKey(
    "message",
    chatId,
    options.message_thread_id,
    options.sourceMessageId,
    options.dedupKey,
  );
  const now = Date.now();
  cleanupDedupCache(now);

  if (dedupKey) {
    const cached = dedupCache.get(dedupKey);
    if (cached && cached.expiresAt > now) {
      return cached.message;
    }
  }

  return runInSendQueue(chatId, options.message_thread_id, async () => {
    const innerNow = Date.now();
    cleanupDedupCache(innerNow);

    if (dedupKey) {
      const cached = dedupCache.get(dedupKey);
      if (cached && cached.expiresAt > innerNow) {
        return cached.message;
      }
    }

    const { sourceMessageId: _sourceMessageId, dedupKey: _dedupKey, ...botOptions } = options;
    const sent = await performWithRetry(() => bot.sendMessage(chatId, text, botOptions));
    if (!sent.message_id) {
      throw new Error("Telegram sendMessage returned no message_id");
    }

    if (dedupKey) {
      dedupCache.set(dedupKey, {
        message: sent,
        expiresAt: Date.now() + DEDUP_TTL_MS,
      });
    }
    return sent;
  });
}

export async function sendPhotoWithRetry(
  bot: TelegramBot,
  chatId: string | number,
  photo: string,
  options: ReliableSendPhotoOptions,
): Promise<Message> {
  const dedupKey = buildDedupKey(
    "photo",
    chatId,
    options.message_thread_id,
    options.sourceMessageId,
    options.dedupKey,
  );
  const now = Date.now();
  cleanupDedupCache(now);

  if (dedupKey) {
    const cached = dedupCache.get(dedupKey);
    if (cached && cached.expiresAt > now) {
      return cached.message;
    }
  }

  return runInSendQueue(chatId, options.message_thread_id, async () => {
    const innerNow = Date.now();
    cleanupDedupCache(innerNow);

    if (dedupKey) {
      const cached = dedupCache.get(dedupKey);
      if (cached && cached.expiresAt > innerNow) {
        return cached.message;
      }
    }

    const { sourceMessageId: _sourceMessageId, dedupKey: _dedupKey, ...botOptions } = options;
    const sent = await performWithRetry(() => bot.sendPhoto(chatId, photo, botOptions));
    if (!sent.message_id) {
      throw new Error("Telegram sendPhoto returned no message_id");
    }

    if (dedupKey) {
      dedupCache.set(dedupKey, {
        message: sent,
        expiresAt: Date.now() + DEDUP_TTL_MS,
      });
    }
    return sent;
  });
}
