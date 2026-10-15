import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

test('brand and favicon use the official rounded Atlas application artwork', async () => {
  const html = await readFile('index.html', 'utf8'); const doc = new JSDOM(html).window.document;
  const icon = doc.querySelector('.wordmark .brand-icon'); assert.ok(icon); assert.equal(icon.getAttribute('aria-hidden'), 'true');
  assert.equal(doc.querySelector('.wordmark')!.textContent, 'Atlas.');
  const favicon = doc.querySelector('link[rel="icon"]')!;
  assert.equal(favicon.getAttribute('type'), 'image/png');
  assert.equal(favicon.getAttribute('href'), '/brand/atlas-app-logo.png');
  assert.equal(doc.querySelector('meta[name="theme-color"]')!.getAttribute('content'), '#10121F');
  assert.ok((await readFile('public/brand/atlas-app-logo.png')).length > 0);
});

test('one CSS accent drives icon and dot; only active connection states have its indicator', async () => {
  const css = await readFile('src/client/style.css', 'utf8');
  assert.match(css, /--atlas-accent: #35E6D0/);
  assert.match(css, /\.brand-icon \{[^}]*background: url\("\/brand\/atlas-app-logo\.png"\) center \/ contain no-repeat/);
  assert.match(css, /\.brand-dot \{ color: var\(--atlas-accent\)/);
  assert.match(css, /\.state-dot \{[^}]*background: #6d7c8f/);
  const rule = css.match(/body\[data-state="connected"\][^{}]+\{ background: var\(--atlas-accent\); \}/)![0]!;
  for (const state of ['connected', 'listening', 'thinking', 'speaking']) assert.ok(rule.includes(`data-state="${state}"`));
  for (const state of ['disconnected', 'error', 'connecting']) assert.ok(!rule.includes(`data-state="${state}"`));
  assert.match(css, /\.brand-icon \{ width: 1\.5rem; aspect-ratio: 1/);
});
