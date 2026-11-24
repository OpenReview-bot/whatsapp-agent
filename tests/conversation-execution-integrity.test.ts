import { describe, expect, it } from 'bun:test';
import { ConversationCoordinator } from '../src/agent/conversation-coordinator';
import { AgentTurnCoordinator } from '../src/agent/turn-coordinator';
import type { ChatMessage } from '../src/domain/types';

type DecisionResult = Awaited<ReturnType<AgentTurnCoordinator['processInboundMessage']>>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/**
 * Bounded negative-assertion window. Long enough that a defective queue
 * (one that proceeds after its configured wait expires) would have run the
 * work; not a substitute for synchronization, only an upper bound on how
 * long we wait before asserting the work never started.
 */
const NEGATIVE_WINDOW_MS = 90;

const replyResult: DecisionResult = {
  decision: {
    action: 'reply',
    intent: 'test',
    replyText: 'ok',
    confidence: 1,
    simulatedDelayMs: 0,
    reasoning: 'test'
  },
  shouldSendImmediately: true
};

function makeMessage(id: string, chatId = 'chat1@s.whatsapp.net'): ChatMessage {
  return { id, chatId, sender: chatId, text: 'hello', timestamp: Date.now(), isFromMe: false, type: 'text' };
}

function makeTurnCoordinator(
  process: (message: ChatMessage) => Promise<DecisionResult>,
  turnTimeoutMs: number
) {
  return new AgentTurnCoordinator(
    {
      moderator: { processInboundMessage: process },
      memory: { getChat: () => undefined },
      operator: {
        resolve: async () => ({ status: 'answered' as const, reply: '', evidence: [], workflowId: 'none' })
      },
      enabled: false
    },
    { turnTimeoutMs }
  );
}

describe('WA-002 ConversationCoordinator queue integrity', () => {
  it('an expired queued task never runs, and successors still wait for the active predecessor', async () => {
    const coordinator = new ConversationCoordinator({ timeoutMs: 80 });
    const a = deferred<string>();
    const events: string[] = [];
    let bRan = false;

    const runA = coordinator.run('brand', 'contact', async () => {
      events.push('a:start');
      await a.promise;
      events.push('a:end');
      return 'a';
    });
    const runB = coordinator.run('brand', 'contact', async () => {
      bRan = true;
      return 'b';
    });

    // B's wait expires while A is still active: B must be rejected, not run.
    await expect(runB).rejects.toThrow(/timeout|expired/i);
    expect(bRan).toBe(false);

    // C arrives after B's expiry. A defective queue would have dropped B's
    // chain slot on expiry, letting C start next to the still-active A.
    let cRan = false;
    const runC = coordinator.run('brand', 'contact', async () => {
      cRan = true;
      events.push('c');
      return 'c';
    });

    // While A is held, C must not run, no matter how B's expiry was handled.
    // (40ms < the 80ms wait bound, so C is still legitimately waiting here.)
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(cRan).toBe(false);

    a.resolve('done');
    await expect(runA).resolves.toBe('a');
    await expect(runC).resolves.toBe('c');
    expect(events).toEqual(['a:start', 'a:end', 'c']);
    // Expired work must never execute later, even after the queue recovers.
    expect(bRan).toBe(false);
    expect(coordinator.activeConversations).toBe(0);
  });

  it('a failed predecessor does not block the queue', async () => {
    const coordinator = new ConversationCoordinator({ timeoutMs: 1000 });
    const gate = deferred<void>();

    const runA = coordinator.run('brand', 'contact', async () => {
      await gate.promise;
      throw new Error('boom');
    });
    const runB = coordinator.run('brand', 'contact', async () => 'b');

    gate.resolve();
    await expect(runA).rejects.toThrow('boom');
    await expect(runB).resolves.toBe('b');
    expect(coordinator.activeConversations).toBe(0);
  });

  it('independent conversations progress concurrently', async () => {
    const coordinator = new ConversationCoordinator({ timeoutMs: 1000 });
    const gateA = deferred<void>();
    const started: string[] = [];

    const runA = coordinator.run('brand', 'contact-a', async () => {
      started.push('a');
      await gateA.promise;
      return 'a';
    });
    const runB = coordinator.run('brand', 'contact-b', async () => {
      started.push('b');
      return 'b';
    });

    await expect(runB).resolves.toBe('b');
    expect(started).toEqual(['a', 'b']);
    gateA.resolve();
    await expect(runA).resolves.toBe('a');
    expect(coordinator.activeConversations).toBe(0);
  });

  it('repeated wait expiries clean up and the queue recovers', async () => {
    const coordinator = new ConversationCoordinator({ timeoutMs: 80 });
    const blocker = deferred<void>();

    const runA = coordinator.run('brand', 'contact', () => blocker.promise);
    await expect(
      coordinator.run('brand', 'contact', async () => 'lost-1')
    ).rejects.toThrow(/timeout|expired/i);
    await expect(
      coordinator.run('brand', 'contact', async () => 'lost-2')
    ).rejects.toThrow(/timeout|expired/i);

    blocker.resolve();
    await runA;
    await expect(coordinator.run('brand', 'contact', async () => 'after')).resolves.toBe('after');
    expect(coordinator.activeConversations).toBe(0);
  });
});

describe('WA-001 AgentTurnCoordinator turn ownership', () => {
  it('retains chat ownership until the timed-out turn actually settles; expired queued turns never process', async () => {
    const gate = deferred<DecisionResult>();
    let moderatorCalls = 0;
    const coordinator = makeTurnCoordinator(async () => {
      moderatorCalls += 1;
      await gate.promise;
      return replyResult;
    }, 30);

    // Turn 1 times out against the caller, but its processing continues.
    const r1 = await coordinator.processInboundMessage(makeMessage('m1'));
    expect(r1.decision.intent).toBe('processing_timeout');
    // A timed-out result must not masquerade as a persisted draft.
    expect(r1.decision.action).toBe('ignore');
    expect(r1.shouldSendImmediately).toBe(false);

    // The expired turn still owns the chat: m2 must fail closed, never process.
    const r2 = await coordinator.processInboundMessage(makeMessage('m2'));
    expect(r2.decision.intent).toBe('turn_queue_expired');
    expect(r2.decision.action).toBe('ignore');
    expect(r2.shouldSendImmediately).toBe(false);
    expect(moderatorCalls).toBe(1);

    // Once the expired turn actually settles, the chat recovers.
    gate.resolve(replyResult);
    const r3 = await coordinator.processInboundMessage(makeMessage('m3'));
    expect(r3.decision.action).toBe('reply');
    expect(moderatorCalls).toBe(2);
  });

  it('serializes overlapping messages for one chat while independent chats progress', async () => {
    const gates = new Map<string, ReturnType<typeof deferred<DecisionResult>>>();
    const active: string[] = [];
    const CHAT1 = 'chat1@s.whatsapp.net';
    let maxConcurrentChat1 = 0;
    let concurrentChat1 = 0;
    const coordinator = makeTurnCoordinator(async (message) => {
      if (message.chatId === CHAT1) {
        concurrentChat1 += 1;
        maxConcurrentChat1 = Math.max(maxConcurrentChat1, concurrentChat1);
      }
      active.push(message.id);
      const gate = deferred<DecisionResult>();
      gates.set(message.id, gate);
      const result = await gate.promise;
      if (message.chatId === CHAT1) concurrentChat1 -= 1;
      return result;
    }, 5000);

    const p1 = coordinator.processInboundMessage(makeMessage('m1'));
    const p2 = coordinator.processInboundMessage(makeMessage('m2'));
    const other = coordinator.processInboundMessage(makeMessage('x1', 'chat2@s.whatsapp.net'));

    // m2 is queued behind m1; the independent chat2 turn starts immediately.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(active.sort()).toEqual(['m1', 'x1']);

    gates.get('x1')!.resolve(replyResult);
    await other;
    gates.get('m1')!.resolve(replyResult);
    await p1;
    await new Promise((resolve) => setTimeout(resolve, 20));
    gates.get('m2')!.resolve(replyResult);
    await p2;
    expect(maxConcurrentChat1).toBe(1);
  });

  it('discards the late result of an expired turn instead of publishing it', async () => {
    const gate = deferred<DecisionResult>();
    const coordinator = makeTurnCoordinator(async () => {
      await gate.promise;
      return replyResult;
    }, 30);

    const r1 = await coordinator.processInboundMessage(makeMessage('m1'));
    expect(r1.decision.intent).toBe('processing_timeout');

    // The real result arrives after the caller already received the fallback.
    gate.resolve(replyResult);
    await new Promise((resolve) => setTimeout(resolve, 20));

    // The chat is healthy again and the next message processes normally.
    const coordinator2 = makeTurnCoordinator(async () => replyResult, 1000);
    const r2 = await coordinator2.processInboundMessage(makeMessage('m2'));
    expect(r2.decision.action).toBe('reply');
  });

  it('ignores historical and replayed messages without queue interaction', async () => {
    let calls = 0;
    const coordinator = makeTurnCoordinator(async () => {
      calls += 1;
      return replyResult;
    }, 1000);

    const historical = await coordinator.processInboundMessage(makeMessage('h1'), { historical: true });
    const replayed = await coordinator.processInboundMessage(makeMessage('r1'), { replayed: true });
    expect(historical.decision.action).toBe('ignore');
    expect(replayed.decision.action).toBe('ignore');
    expect(calls).toBe(0);
  });
});
