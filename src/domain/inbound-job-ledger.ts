import { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import type { ChatMessage } from './types';

export type InboundJobState = 'pending' | 'claimed' | 'completed' | 'failed';

export interface InboundJob {
  id: string;
  chatId: string;
  messageId: string;
  payload: ChatMessage;
  state: InboundJobState;
  attemptCount: number;
  nextAttemptAt: number;
  leaseExpiresAt?: number;
  leaseOwner?: string;
  lastError?: string;
  createdAt: number;
  updatedAt: number;
}

export interface InboundJobEvent {
  id: string;
  jobId: string;
  fromState?: InboundJobState;
  toState: InboundJobState;
  reason: string;
  createdAt: number;
}

export interface FailAttemptOptions {
  maxAttempts: number;
  retryDelayMs: number;
}

/**
 * Durable record of inbound response work, one row per accepted inbound
 * message. The job row is written in the same SQLite transaction as the
 * message itself, so a process that dies after acknowledging a message can
 * never leave it visible-but-unworked: on restart the job is still pending
 * (or its expired claim is recovered) and the work is driven exactly once.
 */
export class InboundJobLedger {
  constructor(private db: Database) {
    this.init();
  }

  private init() {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS inbound_jobs (
        id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        state TEXT NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL DEFAULT 0,
        lease_expires_at INTEGER,
        lease_owner TEXT,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    this.db.run('CREATE INDEX IF NOT EXISTS idx_inbound_jobs_due ON inbound_jobs(state, next_attempt_at)');
    this.db.run(`
      CREATE TABLE IF NOT EXISTS inbound_job_events (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        from_state TEXT,
        to_state TEXT NOT NULL,
        reason TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
    this.db.run('CREATE INDEX IF NOT EXISTS idx_inbound_job_events_job ON inbound_job_events(job_id, created_at)');
  }

  private atomic<T>(work: () => T): T {
    // Bun's declared transaction.immediate return is void, but runtime returns the callback result.
    return this.db.transaction(work).immediate() as unknown as T;
  }

  private event(jobId: string, from: InboundJobState | undefined, to: InboundJobState, reason: string, at: number) {
    this.db.prepare(`
      INSERT INTO inbound_job_events (id, job_id, from_state, to_state, reason, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), jobId, from ?? null, to, reason, at);
  }

  private rowToJob(row: any): InboundJob {
    return {
      id: row.id,
      chatId: row.chat_id,
      messageId: row.message_id,
      payload: JSON.parse(row.payload_json) as ChatMessage,
      state: row.state,
      attemptCount: row.attempt_count,
      nextAttemptAt: row.next_attempt_at,
      leaseExpiresAt: row.lease_expires_at ?? undefined,
      leaseOwner: row.lease_owner ?? undefined,
      lastError: row.last_error ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  /** Stable job identity for an inbound event: one job per message, ever. */
  static jobIdFor(chatId: string, messageId: string): string {
    return `${chatId}:${messageId}`;
  }

  getJob(id: string): InboundJob | undefined {
    const row = this.db.prepare('SELECT * FROM inbound_jobs WHERE id=?').get(id) as any;
    return row ? this.rowToJob(row) : undefined;
  }

  /**
   * Idempotent create: an already-known message returns its existing job,
   * whatever state that job is in, so replays never reset or duplicate work.
   */
  createJob(message: ChatMessage, now = Date.now()): { job: InboundJob; created: boolean } {
    return this.atomic(() => {
      const id = InboundJobLedger.jobIdFor(message.chatId, message.id);
      const existing = this.getJob(id);
      if (existing) return { job: existing, created: false };
      this.db.prepare(`
        INSERT INTO inbound_jobs (
          id, chat_id, message_id, payload_json, state, next_attempt_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'pending', 0, ?, ?)
      `).run(id, message.chatId, message.id, JSON.stringify(message), now, now);
      this.event(id, undefined, 'pending', 'job_created', now);
      return { job: this.getJob(id)!, created: true };
    });
  }

  /** Caller must already be inside a transaction (used by the atomic message+job path). */
  createJobInTransaction(message: ChatMessage, now = Date.now()): { job: InboundJob; created: boolean } {
    const id = InboundJobLedger.jobIdFor(message.chatId, message.id);
    const existing = this.getJob(id);
    if (existing) return { job: existing, created: false };
    this.db.prepare(`
      INSERT INTO inbound_jobs (
        id, chat_id, message_id, payload_json, state, next_attempt_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'pending', 0, ?, ?)
    `).run(id, message.chatId, message.id, JSON.stringify(message), now, now);
    this.event(id, undefined, 'pending', 'job_created', now);
    return { job: this.getJob(id)!, created: true };
  }

  claim(id: string, owner: string, now = Date.now(), leaseMs = 30_000): InboundJob | undefined {
    return this.atomic(() => {
      const job = this.getJob(id);
      if (!job || job.state !== 'pending' || job.nextAttemptAt > now) return undefined;
      const changed = this.db.prepare(`
        UPDATE inbound_jobs SET state='claimed', attempt_count=attempt_count+1,
        lease_expires_at=?, lease_owner=?, updated_at=? WHERE id=? AND state='pending'
      `).run(now + leaseMs, owner, now, id);
      if (changed.changes !== 1) return undefined;
      this.event(id, 'pending', 'claimed', 'claimed', now);
      return this.getJob(id);
    });
  }

  complete(id: string, now = Date.now()): InboundJob | undefined {
    return this.atomic(() => {
      const job = this.getJob(id);
      if (!job || (job.state !== 'claimed' && job.state !== 'pending')) return undefined;
      const changed = this.db.prepare(`
        UPDATE inbound_jobs SET state='completed', lease_expires_at=NULL, lease_owner=NULL, updated_at=?
        WHERE id=? AND state IN ('claimed','pending')
      `).run(now, id);
      if (changed.changes !== 1) return undefined;
      this.event(id, job.state, 'completed', 'work_done', now);
      return this.getJob(id);
    });
  }

  failAttempt(id: string, error: string, now = Date.now(), options: FailAttemptOptions = { maxAttempts: 3, retryDelayMs: 5_000 }): InboundJob | undefined {
    return this.atomic(() => {
      const job = this.getJob(id);
      if (!job || job.state !== 'claimed') return undefined;
      const willRetry = job.attemptCount < options.maxAttempts;
      const nextState: InboundJobState = willRetry ? 'pending' : 'failed';
      const changed = this.db.prepare(`
        UPDATE inbound_jobs SET state=?, next_attempt_at=?, lease_expires_at=NULL, lease_owner=NULL,
        last_error=?, updated_at=? WHERE id=? AND state='claimed'
      `).run(nextState, willRetry ? now + options.retryDelayMs : 0, error, now, id);
      if (changed.changes !== 1) return undefined;
      this.event(id, 'claimed', nextState, willRetry ? 'attempt_failed' : 'attempts_exhausted', now);
      return this.getJob(id);
    });
  }

  /** Returns expired claims to pending; the owner process is presumed dead. */
  recoverExpiredLeases(now = Date.now(), limit = 1_000): number {
    return this.atomic(() => {
      const rows = this.db.prepare(`
        SELECT id FROM inbound_jobs WHERE state='claimed' AND lease_expires_at <= ? LIMIT ?
      `).all(now, limit) as Array<{ id: string }>;
      for (const { id } of rows) {
        const changed = this.db.prepare(`
          UPDATE inbound_jobs SET state='pending', lease_expires_at=NULL, lease_owner=NULL, updated_at=?
          WHERE id=? AND state='claimed'
        `).run(now, id);
        if (changed.changes === 1) this.event(id, 'claimed', 'pending', 'lease_expired', now);
      }
      return rows.length;
    });
  }

  due(now = Date.now(), limit = 100): InboundJob[] {
    const rows = this.db.prepare(`
      SELECT * FROM inbound_jobs WHERE state='pending' AND next_attempt_at <= ?
      ORDER BY created_at ASC LIMIT ?
    `).all(now, limit) as any[];
    return rows.map((r) => this.rowToJob(r));
  }

  getEvents(id: string): InboundJobEvent[] {
    const rows = this.db.prepare('SELECT * FROM (SELECT *, rowid AS event_order FROM inbound_job_events WHERE job_id=? ORDER BY created_at DESC, rowid DESC LIMIT 100) ORDER BY created_at ASC, event_order ASC').all(id) as any[];
    return rows.map((r) => ({
      id: r.id, jobId: r.job_id, fromState: r.from_state ?? undefined,
      toState: r.to_state, reason: r.reason, createdAt: r.created_at
    }));
  }
}
