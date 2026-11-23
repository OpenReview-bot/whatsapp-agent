import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { CallToolRequestSchema as _c, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createWhatsAppMcpServer } from '../src/mcp/server';
import { MemoryStore } from '../src/domain/memory-store';
import { ModeratorAgent } from '../src/ai/moderator-agent';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

async function runtimeTools(): Promise<Array<{ name: string; properties: string[]; required: string[] }>> {
  const memory = new MemoryStore({ dataDir: './data/test-readme-parity' });
  const agent = new ModeratorAgent({ generateContent: async () => ({ text: '{}' }) } as any, memory);
  const server = createWhatsAppMcpServer({ memoryStore: memory, whatsappClient: {} as any, moderatorAgent: agent, funnelEngine: {} as any });
  const handler = (server as any)._requestHandlers.get(ListToolsRequestSchema.shape.method.value);
  const result = await handler({ method: 'tools/list' }, {});
  return result.tools.map((t: any) => ({
    name: t.name,
    properties: Object.keys(t.inputSchema?.properties ?? {}),
    required: t.inputSchema?.required ?? []
  }));
}

describe('README stays in step with the runtime', () => {
  it('documents exactly the MCP tools the server registers, with matching parameters', async () => {
    const readme = read('../README.md');
    const section = readme.split('### Available MCP tools')[1]?.split(/\n#{2,3} /)[0] ?? '';
    const rows = [...section.matchAll(/^\| `(whatsapp_[a-z_]+)` \| (.*?) \| /gm)];
    const documented = new Map(rows.map(r => [r[1], r[2]]));
    const runtime = await runtimeTools();
    expect([...documented.keys()].sort()).toEqual(runtime.map(t => t.name).sort());
    for (const tool of runtime) {
      const cell = documented.get(tool.name) ?? '';
      for (const prop of tool.properties) expect(cell).toContain(prop + (tool.required.includes(prop) ? ':' : '?:'));
    }
  });

  it('states the same tool count as the runtime registry', async () => {
    const readme = read('../README.md');
    const claimed = [...readme.matchAll(/exposing (\d+) tools/g)].map(m => Number(m[1]));
    expect(claimed.length).toBeGreaterThan(0);
    for (const n of claimed) expect(n).toBe((await runtimeTools()).length);
  });

  it('does not hardcode test counts or an unmeasured memory figure', () => {
    for (const file of ['../README.md', '../docs/whatsapp-context-fold.md']) {
      const text = read(file);
      expect(text).not.toMatch(/\b\d+ (?:passing|pass|skipped|failing)\b/i);
      expect(text).not.toMatch(/~?\s?\d+\s?MB RAM/i);
    }
  });
});
