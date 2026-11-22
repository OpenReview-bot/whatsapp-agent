export type CheckLevel = 'pass' | 'warn' | 'fail';
export interface DoctorCheck {
  id: string;
  section: 'preflight' | 'live';
  level: CheckLevel;
  label: string;
  detail?: string;
}

export interface DoctorProbes {
  bunVersion: string;
  env: Record<string, string | undefined>;
  /** Opens the local chat store; throws when unusable. Returns the indexed chat count. */
  openStorage: () => number;
  /** True when the web cockpit build exists. */
  uiBuilt: () => boolean;
  /** Resolves true when gcloud application-default credentials work. */
  gcloudAuthenticated: () => Promise<boolean>;
  /** True when a paired Baileys session is saved. */
  sessionPaired: () => boolean;
}

export interface DoctorReport {
  checks: DoctorCheck[];
  failures: number;
  warnings: number;
  preflightOk: boolean;
  liveReady: boolean;
  exitCode: 0 | 1;
}

const MIN_BUN: [number, number] = [1, 3];
const META_VARS = [
  'META_CLOUD_GRAPH_VERSION', 'META_CLOUD_PHONE_NUMBER_ID', 'META_CLOUD_BUSINESS_ACCOUNT_ID',
  'META_CLOUD_ACCESS_TOKEN', 'META_CLOUD_APP_SECRET', 'META_CLOUD_VERIFY_TOKEN'
];

function bunAtLeast(version: string): boolean {
  const [major, minor] = version.split('.').map((n) => Number.parseInt(n, 10));
  return Number.isFinite(major) && (major > MIN_BUN[0] || (major === MIN_BUN[0] && (minor ?? 0) >= MIN_BUN[1]));
}

/**
 * Install preflight (is this checkout runnable) is separate from live readiness (can it
 * actually answer customers now). Any failed check makes the exit code 1. Warnings do not,
 * unless `strict` is set.
 */
export async function runDoctor(probes: DoctorProbes, options: { preflightOnly?: boolean; strict?: boolean } = {}): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  const add = (c: DoctorCheck) => checks.push(c);

  add(bunAtLeast(probes.bunVersion)
    ? { id: 'bun', section: 'preflight', level: 'pass', label: `Bun ${probes.bunVersion}` }
    : { id: 'bun', section: 'preflight', level: 'fail', label: `Bun ${probes.bunVersion} is older than ${MIN_BUN.join('.')}` });

  try {
    const chats = probes.openStorage();
    add({ id: 'storage', section: 'preflight', level: 'pass', label: `Local storage opens (${chats} chats indexed)` });
  } catch (err) {
    add({ id: 'storage', section: 'preflight', level: 'fail', label: 'Local storage cannot be opened', detail: err instanceof Error ? err.message : String(err) });
  }

  add(probes.uiBuilt()
    ? { id: 'ui', section: 'preflight', level: 'pass', label: 'Web cockpit build found (ui/dist)' }
    : { id: 'ui', section: 'preflight', level: 'warn', label: 'Web cockpit not built', detail: 'Run `bun run build` to serve the dashboard.' });

  if (!options.preflightOnly) {
    const hasKey = Boolean(probes.env.GEMINI_API_KEY);
    const adc = hasKey ? false : await probes.gcloudAuthenticated().catch(() => false);
    add(hasKey || adc
      ? { id: 'model-auth', section: 'live', level: 'pass', label: hasKey ? 'Gemini API key configured' : 'Google Cloud ADC authenticated' }
      : { id: 'model-auth', section: 'live', level: 'fail', label: 'No model credentials', detail: 'Set GEMINI_API_KEY or run `gcloud auth application-default login`.' });

    const transport = probes.env.WHATSAPP_TRANSPORT ?? 'baileys';
    if (transport === 'meta-cloud') {
      const missing = META_VARS.filter((name) => !probes.env[name]);
      add(missing.length === 0
        ? { id: 'transport', section: 'live', level: 'pass', label: 'Meta Cloud API variables are all set (not verified against Meta)' }
        : { id: 'transport', section: 'live', level: 'fail', label: 'Meta Cloud API is partially configured', detail: `Missing: ${missing.join(', ')}` });
    } else if (transport === 'baileys') {
      add(probes.sessionPaired()
        ? { id: 'transport', section: 'live', level: 'pass', label: 'Baileys session saved (connection not tested)' }
        : { id: 'transport', section: 'live', level: 'fail', label: 'No paired WhatsApp session', detail: 'Run `bun run cli pair`.' });
    } else {
      add({ id: 'transport', section: 'live', level: 'fail', label: `Unknown WHATSAPP_TRANSPORT "${transport}"`, detail: 'Use baileys or meta-cloud.' });
    }

    const token = probes.env.AGENT_DASHBOARD_TOKEN ?? '';
    const host = probes.env.HOST ?? '127.0.0.1';
    const loopback = ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host.toLowerCase());
    if (!loopback && token.length < 24) {
      add({ id: 'dashboard-auth', section: 'live', level: 'fail', label: 'Non-loopback HOST without a strong AGENT_DASHBOARD_TOKEN', detail: 'Use a token of at least 24 characters.' });
    }
  }

  const failures = checks.filter((c) => c.level === 'fail').length;
  const warnings = checks.filter((c) => c.level === 'warn').length;
  const preflightOk = !checks.some((c) => c.section === 'preflight' && c.level === 'fail');
  const liveReady = !options.preflightOnly && failures === 0;
  const exitCode = failures > 0 || (options.strict === true && warnings > 0) ? 1 : 0;
  return { checks, failures, warnings, preflightOk, liveReady, exitCode };
}

export function formatDoctorReport(report: DoctorReport, options: { preflightOnly?: boolean } = {}): string {
  const icon = { pass: '✓', warn: '⚠', fail: '✗' } as const;
  const lines: string[] = [];
  for (const section of ['preflight', 'live'] as const) {
    const rows = report.checks.filter((c) => c.section === section);
    if (rows.length === 0) continue;
    lines.push(section === 'preflight' ? 'Install preflight' : 'Live readiness');
    for (const c of rows) {
      lines.push(`  ${icon[c.level]} ${c.label}`);
      if (c.detail) lines.push(`    ${c.detail}`);
    }
  }
  lines.push('');
  if (report.failures > 0) {
    lines.push(`NOT READY: ${report.failures} check(s) failed${report.warnings ? `, ${report.warnings} warning(s)` : ''}.`);
  } else if (options.preflightOnly) {
    lines.push('Preflight passed. Live readiness was not checked (run `doctor` without --preflight).');
  } else {
    lines.push(`Ready to start${report.warnings ? ` (${report.warnings} warning(s))` : ''}. Credentials and connection are configured, not proven live: start the app and watch the status.`);
  }
  return lines.join('\n');
}
