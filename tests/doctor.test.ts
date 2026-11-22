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
    expect(detail).toContain('META_CLOUD_ACCESS_TOKEN');
    expect(detail).not.toContain('META_CLOUD_PHONE_NUMBER_ID');
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
