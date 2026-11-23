import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WhatsAppSocketClient } from '../src/transport/whatsapp-socket';
import { createApiServer, type ApiDependencies } from '../src/server/api';

const fixtures: string[] = [];

function makeTempSessionDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wa-session-test-'));
  fixtures.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of fixtures.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error
    }
  }
});

describe('WhatsAppSocketClient session refresh and recovery', () => {
  it('clearSession() atomically wipes stale session files and leaves a clean directory', () => {
    const sessionDir = makeTempSessionDir();
    writeFileSync(join(sessionDir, 'creds.json'), JSON.stringify({ me: { id: 'test' } }));
    writeFileSync(join(sessionDir, 'app-state-sync-key-1.json'), '{}');

    const client = new WhatsAppSocketClient({ sessionDir });
    expect(readdirSync(sessionDir).length).toBe(2);

    client.clearSession();

    expect(existsSync(sessionDir)).toBe(true);
    expect(readdirSync(sessionDir).length).toBe(0);
  });

  it('self-heals when credentials have me populated but registered is false', async () => {
    const sessionDir = makeTempSessionDir();
    // Simulate dead session from previous device logout
    writeFileSync(
      join(sessionDir, 'creds.json'),
      JSON.stringify({
        registered: false,
        me: { id: '201501903990:5@s.whatsapp.net', name: 'Stale' },
        noiseKey: { private: { type: 'Buffer', data: [] }, public: { type: 'Buffer', data: [] } }
      })
    );
    writeFileSync(join(sessionDir, 'stale-sync-key.json'), '{"dummy":true}');

    const client = new WhatsAppSocketClient({ sessionDir });
    expect(readdirSync(sessionDir).length).toBe(2);

    // Calling clearSession or starting with refresh purges stale files
    client.clearSession();
    expect(readdirSync(sessionDir).length).toBe(0);
  });

  it('disconnect(true) explicitly purges session files', async () => {
    const sessionDir = makeTempSessionDir();
    writeFileSync(join(sessionDir, 'creds.json'), '{}');

    const client = new WhatsAppSocketClient({ sessionDir });
    expect(readdirSync(sessionDir).length).toBe(1);

    await client.disconnect(true);
    expect(readdirSync(sessionDir).length).toBe(0);
  });
});

describe('API connect & disconnect endpoints session management', () => {
  it('POST /api/connect forwards refresh flag to whatsappClient.start', async () => {
    let capturedPhone: string | undefined;
    let capturedOptions: { refresh?: boolean } | undefined;

    const mockClient = {
      getState: () => ({ state: 'disconnected' as const }),
      start: async (phone?: string, options?: { refresh?: boolean }) => {
        capturedPhone = phone;
        capturedOptions = options;
      },
      disconnect: async () => {}
    };

    const app = createApiServer({
      whatsappClient: mockClient as unknown as ApiDependencies['whatsappClient'],
      memoryStore: { getPendingDrafts: () => [] } as unknown as ApiDependencies['memoryStore'],
      moderatorAgent: {} as unknown as ApiDependencies['moderatorAgent'],
      sse: { broadcast: () => {} } as unknown as ApiDependencies['sse']
    });

    const res = await app.request('/api/connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pairingPhoneNumber: '+201012345678', refresh: true })
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ status: 'initiated', phone: '+201012345678', refresh: true });
    expect(capturedPhone as string | undefined).toBe('+201012345678');
    expect(capturedOptions as { refresh?: boolean } | undefined).toEqual({ refresh: true });
  });

  it('POST /api/disconnect forwards clearSession flag to whatsappClient.disconnect', async () => {
    let capturedClearSession: boolean | undefined;

    const mockClient = {
      getState: () => ({ state: 'disconnected' as const }),
      start: async () => {},
      disconnect: async (clearSession?: boolean) => {
        capturedClearSession = clearSession;
      }
    };

    const app = createApiServer({
      whatsappClient: mockClient as unknown as ApiDependencies['whatsappClient'],
      memoryStore: { getPendingDrafts: () => [] } as unknown as ApiDependencies['memoryStore'],
      moderatorAgent: {} as unknown as ApiDependencies['moderatorAgent'],
      sse: { broadcast: () => {} } as unknown as ApiDependencies['sse']
    });

    const res = await app.request('/api/disconnect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clearSession: true })
    });

    expect(res.status).toBe(200);
    expect(capturedClearSession as boolean | undefined).toBe(true);
  });
});
