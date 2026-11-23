import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describeBurst, describeError, hashChatId, logEvent } from '../src/observability/safe-log';

const SECRET = 'my card is 4111 1111 1111 1111, call 201012345678';
const CHAT = '201012345678@s.whatsapp.net';

describe('privacy-safe logging', () => {
  it('burst metadata never contains text, sender or the raw chat id', () => {
    const lines: string[] = [];
    logEvent('info', 'burst_fused', describeBurst({ chatId: CHAT, text: SECRET }, 3), (l) => lines.push(l));
    const out = lines.join('');
    expect(out).not.toContain('4111');
    expect(out).not.toContain('201012345678');
    expect(out).toContain('"chars":' + SECRET.length);
    expect(JSON.parse(out).chat).toBe(hashChatId(CHAT));
  });

  it('drops forbidden keys even when a caller passes them', () => {
    const lines: string[] = [];
    logEvent('warn', 'oops', { text: SECRET, senderName: 'Ali', chatId: CHAT, jid: CHAT, ok: true }, (l) => lines.push(l));
    const parsed = JSON.parse(lines[0]);
    expect(Object.keys(parsed).sort()).toEqual(['event', 'level', 'ok']);
  });

  it('hashes are stable per salt, differ per chat and do not expose the id', () => {
    expect(hashChatId(CHAT, 's1')).toBe(hashChatId(CHAT, 's1'));
    expect(hashChatId(CHAT, 's1')).not.toBe(hashChatId(CHAT, 's2'));
    expect(hashChatId('other@s.whatsapp.net', 's1')).not.toBe(hashChatId(CHAT, 's1'));
    expect(hashChatId(CHAT, 's1')).not.toContain('2010');
  });

  it('describeError omits the error message, which can echo user content', () => {
    expect(describeError(new TypeError(SECRET))).toBe('TypeError');
  });

  it('source guard: no console call interpolates message text, sender name or chat ids in the inbound path', () => {
    const files = ['src/index.ts', 'src/domain/burst-accumulator.ts', 'src/domain/rate-limiter.ts', 'src/agent/reflection-worker.ts'];
    const offending: string[] = [];
    for (const f of files) {
      readFileSync(join(import.meta.dir, '..', f), 'utf8').split('\n').forEach((line, i) => {
        if (/console\.(log|warn|error|info)\(/.test(line) && /(fusedMsg\.(text|sender|senderName|chatId)|\$\{chatId\}|\.fusedText|senderName)/.test(line)) {
          offending.push(`${f}:${i + 1}`);
        }
      });
    }
    expect(offending).toEqual([]);
  });

  it('source guard: inbound-path console calls never pass a raw error or its message', () => {
    const files = ['src/index.ts', 'src/agent/reflection-worker.ts'];
    const offending: string[] = [];
    for (const f of files) {
      readFileSync(join(import.meta.dir, '..', f), 'utf8').split('\n').forEach((line, i) => {
        if (/console\.(log|warn|error|info)\(/.test(line) &&
            /(,\s*(err|error|e)\s*\)|\b(err|error|e)\.message\b|\binstanceof Error \? \w+\.message)/.test(line) &&
            !/describeError/.test(line)) {
          offending.push(`${f}:${i + 1}`);
        }
      });
    }
    expect(offending).toEqual([]);
  });

  it('logEvent drops aliased content keys and cannot be made to override level or event', () => {
    const lines: string[] = [];
    logEvent('error', 'real_event', {
      content: SECRET, messageText: SECRET, chat_id: CHAT, fusedText: SECRET, 'Sender-Name': SECRET,
      level: 'info', event: 'forged', chat: hashChatId(CHAT, 's1'), code: 7
    }, (l) => lines.push(l));
    const out = JSON.parse(lines[0]);
    expect(out.level).toBe('error');
    expect(out.event).toBe('real_event');
    expect(lines[0]).not.toContain(SECRET);
    expect(lines[0]).not.toContain(CHAT);
    expect(out.code).toBe(7);
  });

  it('describeError keeps a safe name and code but never content in a custom name', () => {
    const named = new Error('x'); named.name = SECRET;
    expect(describeError(named)).toBe('Error');
    const coded = Object.assign(new Error('boom'), { code: 'ECONNRESET' });
    expect(describeError(coded)).toBe('Error:ECONNRESET');
  });

  it('a short configured salt is ignored so hashes cannot be enumerated with a guessable salt', () => {
    const before = process.env.LOG_HASH_SALT;
    try {
      process.env.LOG_HASH_SALT = 'abc';
      expect(hashChatId(CHAT)).not.toBe(hashChatId(CHAT, 'abc'));
      process.env.LOG_HASH_SALT = 'a-long-random-secret-value-1234';
      expect(hashChatId(CHAT)).toBe(hashChatId(CHAT, 'a-long-random-secret-value-1234'));
    } finally {
      if (before === undefined) delete process.env.LOG_HASH_SALT; else process.env.LOG_HASH_SALT = before;
    }
  });
});
