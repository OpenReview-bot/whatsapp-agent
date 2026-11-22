import { GeminiClient } from './ai/gemini-client';
import { ModeratorAgent } from './ai/moderator-agent';
import { MemoryStore } from './domain/memory-store';
import { WhatsAppSocketClient } from './transport/whatsapp-socket';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { formatDoctorReport, runDoctor } from './doctor';
import { resolveRuntimeDatastore } from './persistence/postgres/runtime-selection';

resolveRuntimeDatastore();

const [command, ...args] = process.argv.slice(2);

async function doctor(flags: string[]) {
  console.log('🔍 [Fable Agentic WhatsApp Doctor] Diagnosing environment...\n');
  const preflightOnly = flags.includes('--preflight');
  const dataDir = process.env.DATA_DIR ?? './data';
  const report = await runDoctor({
    bunVersion: Bun.version,
    env: process.env,
    openStorage: () => new MemoryStore().listChats().length,
    uiBuilt: () => existsSync('./ui/dist/index.html'),
    gcloudAuthenticated: async () => {
      await Bun.$`gcloud auth print-access-token`.quiet();
      return true;
    },
    sessionPaired: () => existsSync(join(dataDir, 'session', 'creds.json'))
  }, { preflightOnly, strict: flags.includes('--strict') });
  console.log(formatDoctorReport(report, { preflightOnly }));
  process.exitCode = report.exitCode;
}

async function simulate(text: string) {
  if (!text) {
    console.error('Usage: bun run cli simulate "رسالة تجريبية"');
    process.exit(1);
  }
  console.log(`\n🧪 Testing Gemini Moderator Agent with message: "${text}"...\n`);
  const memory = new MemoryStore();
  const gemini = new GeminiClient();
  const agent = new ModeratorAgent(gemini, memory);

  const start = performance.now();
  const result = await agent.processInboundMessage({
    id: `cli_test_${Date.now()}`,
    chatId: 'test_user@s.whatsapp.net',
    sender: 'test_user@s.whatsapp.net',
    senderName: 'عميل تجريبي',
    text,
    timestamp: Date.now(),
    isFromMe: false,
    type: 'text'
  });
  const elapsed = Math.round(performance.now() - start);

  console.log('--- Agent Decision ---');
  if (result.decision.modelRouting) {
    const r = result.decision.modelRouting;
    console.log(`Model Routing (Jev): [${r.tier.toUpperCase()}] -> ${r.selectedModel} (confidence: ${(r.confidence * 100).toFixed(0)}%, latency: ${r.routerLatencyMs}ms)`);
  }
  console.log(`Action: ${result.decision.action.toUpperCase()}`);
  console.log(`Intent: ${result.decision.intent}`);
  console.log(`Confidence: ${(result.decision.confidence * 100).toFixed(0)}%`);
  console.log(`Reasoning: ${result.decision.reasoning}`);
  console.log(`Simulated Typing Delay: ${result.decision.simulatedDelayMs}ms`);
  if (result.decision.replyText) {
    console.log(`\n💬 Proposed Human Reply:\n"${result.decision.replyText}"`);
  }
  if (result.decision.suggestedReaction) {
    console.log(`Suggested Reaction: ${result.decision.suggestedReaction}`);
  }
  console.log(`\n(Execution time: ${elapsed}ms)`);
}

async function pair(phoneNumber?: string) {
  console.log('📱 [WhatsApp Pairing] Starting WhatsApp companion client...');
  const client = new WhatsAppSocketClient({
    onStateChange: (state) => {
      if (state.state === 'qr_ready') {
        console.log('\n📷 [QR Code Ready] Open the Web UI at http://localhost:3000 to scan the QR code!\n');
      } else if (state.state === 'pairing_code_ready') {
        console.log(`\n🔑 [Pairing Code] Enter this 8-digit code on WhatsApp: ${state.pairingCode}\n`);
      } else if (state.state === 'connected') {
        console.log(`\n✅ Connected to WhatsApp as: ${state.connectedUser?.name || state.connectedUser?.phone}\n`);
      }
    }
  });
  await client.start(phoneNumber);
}

switch (command) {
  case 'doctor':
    await doctor(args);
    break;
  case 'simulate':
    await simulate(args.join(' '));
    break;
  case 'pair':
    await pair(args[0]);
    break;
  default:
    console.log(`
Fable Agentic WhatsApp CLI
Usage:
  bun run cli doctor [--preflight] [--strict]
                                     Install preflight plus live readiness; exits 1 on any failure
  bun run cli simulate "<text>"      Test Gemini moderator response from CLI
  bun run cli pair [phone]           Initiate WhatsApp companion pairing
  bun run dev                        Start full web server + agent engine
  bun run mcp                        Start Model Context Protocol stdio server
`);
}
