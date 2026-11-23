import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

// Regressions for findings from an axe-core run (WCAG 2.1 A/AA) against the built cockpit in Chrome.
const uiRoot = fileURLToPath(new URL('..', import.meta.url));
const vite = await createServer({ root: uiRoot, configFile: false, server: { middlewareMode: true }, appType: 'custom' });
after(async () => { await vite.close(); });

const { LocaleProvider } = await vite.ssrLoadModule('/src/i18n.tsx');
const { App } = await vite.ssrLoadModule('/src/App.tsx');
const { OwnerAccessLogin } = await vite.ssrLoadModule('/src/components/OwnerAccessGate.tsx');
const { PairingModal } = await vite.ssrLoadModule('/src/components/PairingModal.tsx');
const { SimulatorModal } = await vite.ssrLoadModule('/src/components/SimulatorModal.tsx');

const render = (language, component) =>
  renderToStaticMarkup(React.createElement(LocaleProvider, { initial: language }, component));
const text = (html) => html.replace(/<svg[\s\S]*?<\/svg>/g, '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();

function buttonByClass(html, cls) {
  const match = html.match(new RegExp(`<button[^>]*class="[^"]*${cls}[^"]*"[^>]*>([\\s\\S]*?)</button>`));
  assert.ok(match, `button .${cls} not rendered`);
  return { open: match[0].slice(0, match[0].indexOf('>') + 1), visible: text(match[1]) };
}

test('buttons with visible text keep that text in their accessible name (WCAG 2.5.3)', () => {
  for (const language of ['ar', 'en']) {
    const login = render(language, React.createElement(OwnerAccessLogin, { onLogin: async () => {}, onRetry: () => {} }));
    const lang = buttonByClass(login, 'wa-owner-language');
    const langLabel = lang.open.match(/aria-label="([^"]*)"/)?.[1] ?? lang.visible;
    assert.ok(langLabel.includes(lang.visible), `${language}: "${langLabel}" must contain "${lang.visible}"`);

    const app = render(language, React.createElement(App));
    const trigger = buttonByClass(app, 'wa-header-agent-trigger');
    const triggerLabel = trigger.open.match(/aria-label="([^"]*)"/)?.[1] ?? trigger.visible;
    const visibleWords = trigger.visible.replace(/\d+/g, '').trim();
    assert.ok(triggerLabel.includes(visibleWords), `${language}: "${triggerLabel}" must contain "${visibleWords}"`);
  }
});

test('decorative model icons are hidden from assistive technology', () => {
  // The model icon renders a role="img" element with no name, so it must sit in an aria-hidden wrapper.
  for (const file of ['ModeratorDrawer', 'PersonaSettingsPage']) {
    const source = readFileSync(new URL(`../src/components/${file}.tsx`, import.meta.url), 'utf8');
    const uses = source.match(/<ModelIcon\b/g) || [];
    const wrapped = source.match(/<span aria-hidden="true"[^>]*><ModelIcon\b/g) || [];
    assert.ok(uses.length > 0, `${file} no longer uses ModelIcon; update this test`);
    assert.equal(wrapped.length, uses.length, `${file}: every <ModelIcon> must be inside an aria-hidden span`);
  }
});

test('dialog headings are not page-level banner landmarks', () => {
  const pairing = render('en', React.createElement(PairingModal, {
    status: { state: 'disconnected', pendingDraftsCount: 0, updatedAt: 0 }, isOpen: true, onClose() {}, onConnect: async () => {}, onDisconnect: async () => {}
  }));
  const sim = render('en', React.createElement(SimulatorModal, { isOpen: true, onClose() {}, onSimulate: async () => ({}) }));
  assert.doesNotMatch(pairing, /<header/);
  assert.doesNotMatch(sim, /<header/);
});

function luminance(hex) {
  const channels = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}
const contrast = (a, b) => { const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };

test('message timestamps meet AA contrast on the outgoing bubble', () => {
  const css = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8');
  const outgoing = css.match(/--wa-outgoing:\s*(#[0-9a-f]{6})/i)[1];
  const meta = css.match(/\.wa-message-meta\s*\{[^}]*?color:\s*(#[0-9a-f]{6})/i)[1];
  assert.ok(contrast(meta, outgoing) >= 4.5, `${meta} on ${outgoing} is ${contrast(meta, outgoing).toFixed(2)}:1`);
});
