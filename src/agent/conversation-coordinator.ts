import { ConversationQueueError, ExecutionQueue } from './execution-queue';

export { ConversationQueueError };

/**
 * Serializes active planner turns for one brand/contact within this process.
 * Promise tails are removed after the last turn, so inactive conversations
 * consume no retained coordinator state.
 *
 * A queued task whose wait expires is rejected with ConversationQueueError
 * and never runs; it no longer proceeds next to its still-active predecessor
 * (WA-002). Successors queued behind an expired task still serialize on the
 * real predecessor.
 */
export class ConversationCoordinator {
  private readonly queue: ExecutionQueue;

  constructor(options: { timeoutMs?: number; maxKeys?: number } = {}) {
    this.queue = new ExecutionQueue({ timeoutMs: options.timeoutMs ?? 45_000, maxKeys: options.maxKeys ?? 1000 });
  }

  async run<T>(brandId: string, contactId: string, task: () => Promise<T>): Promise<T> {
    const key = String(brandId.length) + ':' + brandId + contactId;
    const release = await this.queue.acquire(key);
    try {
      return await task();
    } finally {
      release();
    }
  }

  get activeConversations(): number {
    return this.queue.size;
  }
}
