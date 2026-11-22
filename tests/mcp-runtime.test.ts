import { describe, expect, it } from 'bun:test';
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createMcpRuntime } from '../src/mcp/runtime';
import { startManagedChannel } from '../src/mcp/managed-channel';
import { MemoryStore } from '../src/domain/memory-store';
import { ModeratorAgent } from '../src/ai/moderator-agent';
import type { PairingState } from '../src/domain/types';

function fakeClient(opts: { connectOnStart?: boolean; failStart?: boolean } = {}) {
  const calls = { start: 0, disconnect: 0 };
  let listener: (s: PairingState) => void = () => {};
  let state: PairingState = { state: 'disconnected', updatedAt: Date.now() };
  const client: any = {
    calls,
    start: async () => {
      calls.start++;
      if (opts.failStart) throw new Error('boom');
      if (opts.connectOnStart) {
        state = { state: 'connected', updatedAt: Date.now(), connectedUser: { phone: '201000000000' } } as PairingState;
        listener(state);
      }
    },
    disconnect: async () => { calls.disconnect++; },
    getState: () => state,
    sendMessage: async () => ({ messageId: 'm1' }),
    sendReaction: async () => {}
  };
  return { client, bind: (l: (s: PairingState) => void) => { listener = l; return client; } };
}

const deps = (name: string) => {
  const memoryStore = new MemoryStore({ dataDir: `./data/test-mcp-runtime-${name}` });
  const gemini: any = { generateContent: async () => ({ text: '{}' }) };
  return { memoryStore, moderatorAgent: new ModeratorAgent(gemini, memoryStore) };
};

describe('MCP runner composition', () => {
  it('starts the transport exactly once and binds the server to that same client', async () => {
    const f = fakeClient({ connectOnStart: true });
    const logs: string[] = [];
    const runtime = await createMcpRuntime({ ...deps('a'), createClient: f.bind, log: (m) => logs.push(m), connectTimeoutMs: 500 });
    expect(f.client.calls.start).toBe(1);
    expect(runtime.channel?.connected).toBe(true);

    const handler = (runtime.server as any)._requestHandlers.get(CallToolRequestSchema.shape.method.value);
    const res = await handler({ method: 'tools/call', params: { name: 'whatsapp_get_status', arguments: {} } }, {});
    expect(JSON.stringify(res)).toContain('connected');
    await runtime.shutdown();
    expect(f.client.calls.disconnect).toBe(1);
  });

  it('reports a bounded, honest not-connected state instead of hanging or throwing', async () => {
    const f = fakeClient();
    const logs: string[] = [];
    const t0 = Date.now();
    const channel = await startManagedChannel({ createClient: f.bind, connectTimeoutMs: 50, log: (m) => logs.push(m) });
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(channel.connected).toBe(false);
    expect(channel.client.getState().state).toBe('disconnected');
    expect(logs.join('\n')).toContain('Not connected');
  });

  it('survives a transport start failure and logs to the injected sink', async () => {
    const f = fakeClient({ failStart: true });
    const logs: string[] = [];
    const channel = await startManagedChannel({ createClient: f.bind, connectTimeoutMs: 20, log: (m) => logs.push(m) });
    expect(channel.connected).toBe(false);
    expect(logs.some((l) => l.includes('Failed to start'))).toBe(true);
  });

  it('channelMode none never starts the transport', async () => {
    const f = fakeClient();
    const runtime = await createMcpRuntime({ ...deps('b'), createClient: f.bind, channelMode: 'none' });
    expect(f.client.calls.start).toBe(0);
    expect(runtime.channel).toBeNull();
  });
});
