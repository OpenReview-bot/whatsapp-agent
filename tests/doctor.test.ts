import { describe, expect, it } from 'bun:test';
import { formatDoctorReport, runDoctor, type DoctorProbes } from '../src/doctor';

const base = (over: Partial<DoctorProbes> = {}): DoctorProbes => ({
  bunVersion: '1.4.5',
  env: { GEMINI_API_KEY: 'k' },
  openStorage: () => 2,
  uiBuilt: () => true,
  gcloudAuthenticated: async () => false,
  sessionPaired: () => true,
  ...over
});

describe('doctor', () => {
  it('passes with model key, paired session and storage', async () => {
    const r = await runDoctor(base());
    expect(r.exitCode).toBe(0);
    expect(r.liveReady).toBe(true);
    expect(formatDoctorReport(r)).toContain('Ready to start');
  });

  it('fails with exit 1 and never prints a ready message when model auth is missing', async () => {
    const r = await runDoctor(base({ env: {} }));
    expect(r.exitCode).toBe(1);
    expect(r.liveReady).toBe(false);
    const out = formatDoctorReport(r);
    expect(out).toContain('NOT READY');
    expect(out).not.toContain('System ready');
    expect(out).not.toContain('Ready to start');
  });

  it('accepts gcloud ADC when no key is set', async () => {
    const r = await runDoctor(base({ env: {}, gcloudAuthenticated: async () => true }));
    expect(r.exitCode).toBe(0);
  });

  it('treats a throwing gcloud probe as unauthenticated', async () => {
    const r = await runDoctor(base({ env: {}, gcloudAuthenticated: async () => { throw new Error('no gcloud'); } }));
    expect(r.exitCode).toBe(1);
  });

  it('fails when storage cannot open or Bun is too old', async () => {
    const a = await runDoctor(base({ openStorage: () => { throw new Error('locked'); } }));
    expect(a.checks.find((c) => c.id === 'storage')?.level).toBe('fail');
    expect(a.preflightOk).toBe(false);
    expect(a.exitCode).toBe(1);
    const b = await runDoctor(base({ bunVersion: '1.2.9' }));
    expect(b.exitCode).toBe(1);
  });

  it('fails when no WhatsApp session is paired (baileys)', async () => {
    const r = await runDoctor(base({ sessionPaired: () => false }));
    expect(r.exitCode).toBe(1);
    expect(r.checks.find((c) => c.id === 'transport')?.detail).toContain('cli pair');
  });

  it('meta-cloud lists every missing variable', async () => {
    const r = await runDoctor(base({ env: { GEMINI_API_KEY: 'k', WHATSAPP_TRANSPORT: 'meta-cloud', META_CLOUD_PHONE_NUMBER_ID: 'p' } }));
    expect(r.exitCode).toBe(1);
    const detail = r.checks.find((c) => c.id === 'transport')?.detail ?? '';
    for (const name of ['META_CLOUD_GRAPH_VERSION', 'META_CLOUD_BUSINESS_ACCOUNT_ID', 'META_CLOUD_ACCESS_TOKEN',
      'META_CLOUD_APP_SECRET', 'META_CLOUD_VERIFY_TOKEN', 'AGENT_AUTOPILOT_BRAND_ID']) {
      expect(detail).toContain(name);
    }
    expect(detail).not.toContain('META_CLOUD_PHONE_NUMBER_ID');
  });

  it('meta-cloud needs AGENT_AUTOPILOT_BRAND_ID because startup throws without it', async () => {
    const env = { GEMINI_API_KEY: 'k', WHATSAPP_TRANSPORT: 'meta-cloud', META_CLOUD_GRAPH_VERSION: 'v1', META_CLOUD_PHONE_NUMBER_ID: 'p',
      META_CLOUD_BUSINESS_ACCOUNT_ID: 'b', META_CLOUD_ACCESS_TOKEN: 't', META_CLOUD_APP_SECRET: 's', META_CLOUD_VERIFY_TOKEN: 'v' };
    expect((await runDoctor(base({ env }))).exitCode).toBe(1);
    expect((await runDoctor(base({ env: { ...env, AGENT_AUTOPILOT_BRAND_ID: 'brand' } }))).exitCode).toBe(0);
  });

  it('an empty HOST is loopback, like server startup', async () => {
    const r = await runDoctor(base({ env: { GEMINI_API_KEY: 'k', HOST: '' } }));
    expect(r.checks.find((c) => c.id === 'dashboard-auth')).toBeUndefined();
    expect(r.exitCode).toBe(0);
  });

  it('--strict with only a warning is not ready and never prints a ready message', async () => {
    const r = await runDoctor(base({ uiBuilt: () => false }), { strict: true });
    expect(r.exitCode).toBe(1);
    expect(r.liveReady).toBe(false);
    const out = formatDoctorReport(r);
    expect(out).toContain('NOT READY');
    expect(out).not.toContain('Ready to start');
  });

  it('shows why gcloud failed and strips terminal control characters from environment text', async () => {
    const r = await runDoctor(base({ env: { WHATSAPP_TRANSPORT: 'x\u001b[2Jy\nFAKE OK' }, gcloudAuthenticated: async () => { throw new Error('no project\u001b[31m'); } }));
    const out = formatDoctorReport(r);
    expect(out).toContain('no project');
    expect(out).not.toContain('\u001b');
    expect(r.checks.find((c) => c.id === 'transport')?.label).not.toContain('\n');
  });

  it('rejects an unknown transport and an exposed host without a strong token', async () => {
    const a = await runDoctor(base({ env: { GEMINI_API_KEY: 'k', WHATSAPP_TRANSPORT: 'carrier-pigeon' } }));
    expect(a.exitCode).toBe(1);
    const b = await runDoctor(base({ env: { GEMINI_API_KEY: 'k', HOST: '0.0.0.0', AGENT_DASHBOARD_TOKEN: 'short' } }));
    expect(b.checks.find((c) => c.id === 'dashboard-auth')?.level).toBe('fail');
  });

  it('--preflight skips live checks and does not claim live readiness', async () => {
    const r = await runDoctor(base({ env: {}, sessionPaired: () => false }), { preflightOnly: true });
    expect(r.exitCode).toBe(0);
    expect(r.liveReady).toBe(false);
    expect(formatDoctorReport(r, { preflightOnly: true })).toContain('Live readiness was not checked');
  });

  it('--strict turns warnings into a failing exit code', async () => {
    const r = await runDoctor(base({ uiBuilt: () => false }), { strict: true });
    expect(r.warnings).toBe(1);
    expect(r.exitCode).toBe(1);
    expect((await runDoctor(base({ uiBuilt: () => false }))).exitCode).toBe(0);
  });
});
