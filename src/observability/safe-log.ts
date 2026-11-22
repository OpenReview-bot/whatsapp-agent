import { createHmac, randomBytes } from 'node:crypto';

// Salt keeps hashed chat IDs from being reversed by enumerating phone numbers.
// Set LOG_HASH_SALT to correlate IDs across restarts; otherwise it is random per process.
const processSalt = randomBytes(16).toString('hex');

export function hashChatId(chatId: string, salt: string = process.env.LOG_HASH_SALT || processSalt): string {
  return createHmac('sha256', salt).update(chatId).digest('hex').slice(0, 12);
}

export type SafeLogValue = string | number | boolean | null | undefined;

/** Lower-case keys that must never appear in a log line. */
const FORBIDDEN_KEYS = new Set(['text', 'body', 'message', 'sender', 'sendername', 'chatid', 'jid', 'phone', 'caption', 'transcription']);

/**
 * Writes one structured, metadata-only log line. Message content, sender identity and raw
 * chat IDs are rejected by key name so they cannot be added by accident. Use `chat` with
 * hashChatId() to correlate events.
 */
export function logEvent(
  level: 'info' | 'warn' | 'error',
  event: string,
  fields: Record<string, SafeLogValue> = {},
  sink: (line: string) => void = level === 'info' ? console.log : level === 'warn' ? console.warn : console.error
): void {
  const safe: Record<string, SafeLogValue> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (FORBIDDEN_KEYS.has(key.toLowerCase())) continue;
    safe[key] = value;
  }
  sink(JSON.stringify({ level, event, ...safe }));
}

/** Metadata for a fused burst. Never includes text, sender name or the raw chat ID. */
export function describeBurst(msg: { chatId: string; text: string; type?: string }, messageCount?: number): Record<string, SafeLogValue> {
  return { chat: hashChatId(msg.chatId), chars: msg.text.length, type: msg.type ?? 'text', messages: messageCount };
}

/** Error summary without the message, which can echo user content from providers. */
export function describeError(err: unknown): string {
  return err instanceof Error ? err.name : typeof err;
}
