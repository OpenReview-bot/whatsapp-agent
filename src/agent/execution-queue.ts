/**
 * Shared per-key serialized execution ownership contract (WA-001 / WA-002).
 *
 * Invariants:
 * - At most one owner runs side-effect-capable work per key at a time.
 * - A caller whose wait expires NEVER runs its work. Expiry rejects loudly
 *   instead of silently proceeding next to the still-active predecessor.
 * - An expired caller's chain slot stays linked until the real predecessor
 *   settles, so successors keep waiting for that predecessor rather than
 *   bypassing it.
 * - A timed-out Promise is not a cancelled operation: release() is owned by
 *   the acquirer, which decides when the underlying work has actually settled.
 */
export type QueueRejectReason = 'wait_timeout' | 'admission_full';

export class ConversationQueueError extends Error {
  readonly reason: QueueRejectReason;
  constructor(reason: QueueRejectReason, message: string) {
    super(message);
    this.name = 'ConversationQueueError';
    this.reason = reason;
  }
}

export interface ExecutionQueueOptions {
  /** Max time a caller may wait for its predecessor before failing closed. */
  timeoutMs?: number;
  /** Bound on distinct keys with unsettled work; excess admissions fail closed. */
  maxKeys?: number;
}

export class ExecutionQueue {
  private readonly tails = new Map<string, Promise<void>>();
  private readonly timeoutMs: number;
  private readonly maxKeys: number | undefined;

  constructor(options: ExecutionQueueOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 45_000;
    this.maxKeys = options.maxKeys;
  }

  /** Number of keys with unsettled work (including expired-but-chained slots). */
  get size(): number {
    return this.tails.size;
  }

  /**
   * Acquire exclusive execution ownership for `key`.
   * Resolves with an idempotent `release` the caller must invoke once its
   * underlying work has actually settled (not merely timed out).
   * Rejects with ConversationQueueError when admission is full or the wait
   * for the predecessor exceeds the configured timeout; the rejected caller
   * must not run any work.
   */
  async acquire(key: string): Promise<() => void> {
    const previous = this.tails.get(key);
    if (!previous && this.maxKeys !== undefined && this.tails.size >= this.maxKeys) {
      throw new ConversationQueueError(
        'admission_full',
        'Execution queue admission bound reached; refusing new work'
      );
    }

    let releaseSlot!: () => void;
    const current = new Promise<void>((resolve) => {
      releaseSlot = resolve;
    });
    this.tails.set(key, current);

    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      releaseSlot();
      if (this.tails.get(key) === current) this.tails.delete(key);
    };

    if (!previous) return release;

    let waitTimer: ReturnType<typeof setTimeout> | undefined;
    const waitOutcome = await Promise.race([
      previous.then(
        () => 'settled' as const,
        () => 'settled' as const
      ),
      new Promise<'expired'>((resolve) => {
        waitTimer = setTimeout(() => resolve('expired'), this.timeoutMs);
      })
    ]);
    if (waitTimer) clearTimeout(waitTimer);
    if (waitOutcome === 'settled') return release;

    // Wait expired: this caller must never run. Keep its chain slot linked
    // until the real predecessor settles so successors queued behind this
    // slot still serialize on that predecessor, then clean the slot up.
    void previous.then(release, release);
    throw new ConversationQueueError(
      'wait_timeout',
      'Execution queue wait expired while the predecessor was still active'
    );
  }
}
