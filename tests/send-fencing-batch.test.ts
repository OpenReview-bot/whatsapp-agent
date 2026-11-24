import { afterEach, describe, expect, it } from 'bun:test';
import { MemoryStore } from '../src/domain/memory-store';
import { SendIntentService } from '../src/domain/send-intent-service';
import type { SendIntentInput } from '../src/domain/send-ledger';

const stores: MemoryStore[] = [];
const makeStore = () => {
  const memory = new MemoryStore({ dataDir: ':memory:' });
  stores.push(memory);
  return memory;
};

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

const input = (overrides: Partial<SendIntentInput> = {}): SendIntentInput => ({
  sourceKind: 'ui',
  sourceId: 'mutation-1',
  sourceRevision: 1,
  actionKind: 'text',
  chatId: '201111111111@s.whatsapp.net',
  text: 'Hello',
  policyRevision: 1,
  ...overrides
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('WA-004 expired send claims are fenced before network I/O', () => {
  it('a claim whose lease expires during voice preparation never reaches the transport and is requeued', async () => {
    const memory = makeStore();
    const gate = deferred<Buffer>();
    let voiceSent = 0;
    const service = new SendIntentService({
      memoryStore: memory,
      claimLeaseMs: 40,
      prepareVoice: async () => { await gate.promise; return Buffer.from('x'); },
      sendText: async () => ({ messageId: 'native-t' }),
      sendVoice: async () => { voiceSent++; return { messageId: 'native-v' }; }
    });

    const dispatchPromise = service.sendVoice(input({ actionKind: 'voice', text: 'voice note' }));
    // Let the lease expire while prepareVoice is still running, then finish it.
    await sleep(80);
    gate.resolve(Buffer.from('x'));
    const result = await dispatchPromise;

    expect(voiceSent).toBe(0);
    expect(result.intent.state).toBe('queued');
    const attempts = memory.getSendLedger().getAttempts(result.intent.id);
    expect(attempts[0].outcome).toBe('pre_send_failed');
    expect(attempts[0].failureCode).toBe('lease_fenced_pre_network');
    expect(attempts[0].networkStartedAt).toBeUndefined();
  });

  it('a claim recovered as uncertain during preparation stays uncertain and the old worker never sends', async () => {
    const memory = makeStore();
    const gate = deferred<Buffer>();
    let voiceSent = 0;
    const service = new SendIntentService({
      memoryStore: memory,
      claimLeaseMs: 40,
      prepareVoice: async () => { await gate.promise; return Buffer.from('x'); },
      sendText: async () => ({ messageId: 'native-t' }),
      sendVoice: async () => { voiceSent++; return { messageId: 'native-v' }; }
    });

    const dispatchPromise = service.sendVoice(input({ actionKind: 'voice', text: 'voice note' }));
    await sleep(80);
    // The sweeper recovers the abandoned attempt while the old worker still prepares.
    expect(memory.getSendLedger().recoverInterrupted()).toBe(1);
    gate.resolve(Buffer.from('x'));
    const result = await dispatchPromise;

    expect(voiceSent).toBe(0);
    expect(result.intent.state).toBe('uncertain');
  });

  it('the fence refuses an expired claim at the ledger boundary and requeues pre-network', () => {
    const memory = makeStore();
    const ledger = memory.getSendLedger();
    const intent = ledger.createIntent(input());
    const t0 = Date.now();
    const claimed = ledger.claim(intent.id, 'worker-1', t0, 1)!;
    // Lease expired before network start: the fence must refuse, then requeue with proof
    // that no network I/O happened (network_started_at stays NULL).
    expect(ledger.tryMarkNetworkStarted(intent.id, claimed.attempt.id, t0 + 2)).toBe(false);
    const requeued = ledger.requeueFencedPreNetwork(intent.id, claimed.attempt.id, t0 + 1000, 3, t0 + 2)!;
    expect(requeued.state).toBe('queued');
    const attempts = ledger.getAttempts(intent.id);
    expect(attempts[0].outcome).toBe('pre_send_failed');
    expect(attempts[0].failureCode).toBe('lease_fenced_pre_network');
    expect(attempts[0].networkStartedAt).toBeUndefined();
  });

  it('a valid claim still passes the fence and sends exactly once', async () => {
    const memory = makeStore();
    let sent = 0;
    const service = new SendIntentService({
      memoryStore: memory,
      sendText: async () => { sent++; return { messageId: 'native-t' }; }
    });
    const result = await service.sendText(input());
    expect(result.intent.state).toBe('accepted');
    expect(sent).toBe(1);
    const attempts = memory.getSendLedger().getAttempts(result.intent.id);
    expect(attempts[0].networkStartedAt).toBeDefined();
  });
});

describe('WA-015 multipart reply batches persist before dispatch', () => {
  const batchInputs = (): SendIntentInput[] => [1, 2, 3].map((i) => input({
    sourceId: `chat:msg:part-${i}-of-3`,
    text: `bubble ${i}`
  }));

  it('commits every part transactionally before the first dispatch', async () => {
    const memory = makeStore();
    const service = new SendIntentService({
      memoryStore: memory,
      sendText: async () => ({ messageId: 'native-x' })
    });
    const batch = await service.createTextBatch(batchInputs());
    expect(batch).toHaveLength(3);
    // All parts durable with stable batch identity and order BEFORE any dispatch.
    const ledger = memory.getSendLedger();
    const ids = batch.map((b) => b.intent.id);
    for (const [i, item] of batch.entries()) {
      const stored = ledger.getIntent(item.intent.id)!;
      expect(stored.batchId).toBeDefined();
      expect(stored.batchId).toBe(batch[0].intent.batchId!);
      expect(stored.batchOrdinal).toBe(i);
      expect(stored.state).toBe('queued');
    }
    expect(new Set(ids).size).toBe(3);
  });

  it('batch creation is idempotent across a crash between commit and dispatch', async () => {
    const memory = makeStore();
    const service = new SendIntentService({
      memoryStore: memory,
      sendText: async () => ({ messageId: 'native-x' })
    });
    const first = await service.createTextBatch(batchInputs());
    const second = await service.createTextBatch(batchInputs());
    expect(second.map((b) => b.intent.id)).toEqual(first.map((b) => b.intent.id));
  });

  it('a later part never dispatches while its predecessor is not accepted', async () => {
    const memory = makeStore();
    let calls = 0;
    const service = new SendIntentService({
      memoryStore: memory,
      sendText: async () => {
        calls++;
        if (calls === 2) { const e: any = new Error('no socket'); e.code = 'WHATSAPP_NOT_CONNECTED'; throw e; }
        return { messageId: `native-${calls}` };
      }
    });
    const batch = await service.createTextBatch(batchInputs());

    const r1 = await service.dispatch(batch[0].intent.id);
    expect(r1.intent.state).toBe('accepted');
    // Part 2 fails pre-network: queued for retry, NOT ambiguous.
    const r2 = await service.dispatch(batch[1].intent.id);
    expect(r2.intent.state).toBe('queued');
    // Part 3 must refuse to dispatch while part 2 is unfinished.
    const r3 = await service.dispatch(batch[2].intent.id);
    expect(r3.intent.state).toBe('queued');
    expect(calls).toBe(2);

    // After part 2's retry window opens, it recovers and part 3 flows in order.
    const r2b = await service.dispatch(batch[1].intent.id, Date.now() + 60_000);
    expect(r2b.intent.state).toBe('accepted');
    const r3b = await service.dispatch(batch[2].intent.id);
    expect(r3b.intent.state).toBe('accepted');
    expect(calls).toBe(4);
  });

  it('a terminally failed predecessor cancels the remainder', async () => {
    const memory = makeStore();
    let calls = 0;
    const service = new SendIntentService({
      memoryStore: memory,
      maxAttempts: 1,
      sendText: async () => {
        calls++;
        if (calls === 2) { const e: any = new Error('no socket'); e.code = 'WHATSAPP_NOT_CONNECTED'; throw e; }
        return { messageId: `native-${calls}` };
      }
    });
    const batch = await service.createTextBatch(batchInputs());
    await service.dispatch(batch[0].intent.id);
    const r2 = await service.dispatch(batch[1].intent.id);
    expect(r2.intent.state).toBe('failed');
    const r3 = await service.dispatch(batch[2].intent.id);
    expect(r3.intent.state).toBe('failed');
    expect(calls).toBe(2);
  });

  it('an uncertain predecessor blocks later parts until reconciled', async () => {
    const memory = makeStore();
    let calls = 0;
    const service = new SendIntentService({
      memoryStore: memory,
      sendText: async () => {
        calls++;
        if (calls === 2) throw new Error('socket vanished mid-send');
        return { messageId: `native-${calls}` };
      }
    });
    const batch = await service.createTextBatch(batchInputs());
    await service.dispatch(batch[0].intent.id);
    const r2 = await service.dispatch(batch[1].intent.id);
    expect(r2.intent.state).toBe('uncertain');
    // No automatic resend of the ambiguous part, and part 3 stays queued.
    const r3 = await service.dispatch(batch[2].intent.id);
    expect(r3.intent.state).toBe('queued');
    expect(calls).toBe(2);
  });
});
