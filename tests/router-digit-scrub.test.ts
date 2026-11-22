import { describe, expect, it } from 'bun:test';
import { normalizeDigits, routeTurnModel } from '../src/ai/model-router';

const ok = { model: 'jev-latest', answers: {
  route: { type: 'choice', choice: 'standard', confidence: 0.96, probabilities: { trivial: 0.01, standard: 0.96, complex: 0.03 } },
  action_risk: { type: 'choice', choice: 'routine', confidence: 0.96, probabilities: { routine: 0.96, consequential: 0.04 } } } };

async function outgoingState(message: string): Promise<string> {
  let body: any = {};
  await routeTurnModel({
    message, apiKey: 'synthetic-test-key', externalRoutingAllowed: true,
    fetchFn: (async (_u: string | URL | Request, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify(ok), { status: 200 });
    }) as unknown as typeof fetch
  });
  return body.state as string;
}

describe('router phone scrub with Arabic digits', () => {
  it('normalizes Arabic-Indic and Extended Arabic-Indic digits', () => {
    expect(normalizeDigits('٠١٢٣٤٥٦٧٨٩')).toBe('0123456789');
    expect(normalizeDigits('۰۱۲۳۴۵۶۷۸۹')).toBe('0123456789');
    expect(normalizeDigits('abc 12')).toBe('abc 12');
  });

  it('redacts an Arabic-Indic phone number', async () => {
    const state = await outgoingState('كلمني على ٠١٠١٢٣٤٥٦٧٨ ضروري');
    expect(state).toContain('[REDACTED_PHONE]');
    expect(state).not.toMatch(/[٠-٩]{6}/);
  });

  it('redacts an Extended Arabic-Indic phone number with a country code', async () => {
    const state = await outgoingState('call +۲۰ ۱۰۱ ۲۳۴ ۵۶۷۸');
    expect(state).toContain('[REDACTED_PHONE]');
  });

  it('redacts mixed-script digits and leaves short numbers alone', async () => {
    const state = await outgoingState('رقمي 01٠12٣4567٨ والكمية ٥');
    expect(state).toContain('[REDACTED_PHONE]');
    expect(state).toContain('5');
    expect(state).not.toContain('[REDACTED_PHONE] [REDACTED_PHONE]');
  });
});
