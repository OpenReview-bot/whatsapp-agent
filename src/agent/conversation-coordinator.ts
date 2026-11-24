/**
 * Serializes active planner turns for one brand/contact within this process.
 * Promise tails are removed after the last turn, so inactive conversations
 * consume no retained coordinator state.
 */
export class ConversationCoordinator {
  private readonly tails = new Map<string, Promise<void>>();
  private readonly timeoutMs: number;

  constructor(options: { timeoutMs?: number } = {}) {
    this.timeoutMs = options.timeoutMs ?? 45_000;
  }

  async run<T>(brandId: string, contactId: string, task: () => Promise<T>): Promise<T> {
    const key = String(brandId.length) + ':' + brandId + contactId;
    const previous = this.tails.get(key);
    let release: () => void = () => {};
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.tails.set(key, current);

    let waitTimer: ReturnType<typeof setTimeout> | undefined;
    const boundedPrevious = previous
      ? Promise.race([
          previous,
          new Promise<void>((_, reject) => {
            waitTimer = setTimeout(() => reject(new Error('ConversationCoordinator queue timeout')), this.timeoutMs);
          })
        ]).finally(() => {
          if (waitTimer) clearTimeout(waitTimer);
        })
      : Promise.resolve();

    try {
      await boundedPrevious.catch((err) => {
        console.warn('[ConversationCoordinator] Prior task in queue settled with rejection or timeout:', err);
      });
      return await task();
    } finally {
      release();
      if (this.tails.get(key) === current) this.tails.delete(key);
    }
  }

  get activeConversations(): number {
    return this.tails.size;
  }
}
