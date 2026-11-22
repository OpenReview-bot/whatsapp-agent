import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { ModeratorAgent } from '../ai/moderator-agent';
import type { MemoryStore } from '../domain/memory-store';
import type { PairingState } from '../domain/types';
import type { WhatsAppSocketClient } from '../transport/whatsapp-socket';
import { createWhatsAppMcpServer } from './server';
import { startManagedChannel, type ManagedChannel, type ManagedChannelClient } from './managed-channel';

export interface McpRuntimeDeps<C extends ManagedChannelClient> {
  memoryStore: MemoryStore;
  moderatorAgent: ModeratorAgent;
  createClient: (onStateChange: (state: PairingState) => void) => C;
  connectTimeoutMs?: number;
  /** `none` skips the transport so the tools run read-only and report `disconnected`. */
  channelMode?: 'managed' | 'none';
  log?: (message: string) => void;
}

export interface McpRuntime<C extends ManagedChannelClient> {
  server: Server;
  channel: ManagedChannel<C> | null;
  shutdown: () => Promise<void>;
}

/**
 * Composes the standalone MCP runner: transport lifecycle first, then the tool server
 * bound to that same client. Kept separate from cli.ts so the composition is testable.
 */
export async function createMcpRuntime<C extends ManagedChannelClient>(deps: McpRuntimeDeps<C>): Promise<McpRuntime<C>> {
  const mode = deps.channelMode ?? 'managed';
  let holder: C | null = null;
  const channel = mode === 'managed'
    ? await startManagedChannel<C>({
        createClient: (onState) => (holder = deps.createClient(onState)),
        connectTimeoutMs: deps.connectTimeoutMs,
        log: deps.log
      })
    : null;
  const client = channel?.client ?? (holder = deps.createClient(() => {}));
  const server = createWhatsAppMcpServer({
    memoryStore: deps.memoryStore,
    moderatorAgent: deps.moderatorAgent,
    whatsappClient: client as unknown as WhatsAppSocketClient,
    readOnly: mode === 'none'
  });
  return { server, channel, shutdown: async () => { await channel?.stop(); } };
}
