import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

test('brand and favicon reuse the supplied PNG silhouette without redrawing or adding text', async () => {
  const html = await readFile('index.html', 'utf8'); const doc = new JSDOM(html).window.document;
  const icon = doc.querySelector('.wordmark .brand-icon'); assert.ok(icon); assert.equal(icon.getAttribute('aria-hidden'), 'true');
  assert.equal(doc.querySelector('.wordmark')!.textContent, 'Atlas.');
  const favicon = doc.querySelector('link[rel="icon"]')!; assert.equal(favicon.getAttribute('href'), '/brand/atlas-icon.svg');
  const svg = await readFile('public/brand/atlas-icon.svg', 'utf8'); const source = await readFile('public/brand/atlas_blanco.png');
  const embedded = svg.match(/href="data:image\/png;base64,([^"]+)"/)![1]!;
  assert.deepEqual(Buffer.from(embedded, 'base64'), source); // Exact source bytes, not a traced replacement.
  assert.match(svg, /viewBox="16 131 1047 820"/); assert.ok(!/<(?:text|path|polygon)\b/.test(svg));
});

test('one CSS accent drives icon and dot; only active connection states have its indicator', async () => {
  const css = await readFile('src/client/style.css', 'utf8');
  assert.match(css, /--atlas-accent: #35E6D0/);
  assert.match(css, /\.brand-icon \{[^}]*background: var\(--atlas-accent\)/);
  assert.match(css, /\.brand-dot \{ color: var\(--atlas-accent\)/);
  assert.match(css, /\.state-dot \{[^}]*background: #6d7c8f/);
  const rule = css.match(/body\[data-state="connected"\][^{}]+\{ background: var\(--atlas-accent\); \}/)![0]!;
  for (const state of ['connected', 'listening', 'thinking', 'speaking']) assert.ok(rule.includes(`data-state="${state}"`));
  for (const state of ['disconnected', 'error', 'connecting']) assert.ok(!rule.includes(`data-state="${state}"`));
  assert.match(css, /\.brand-icon \{ width: 1\.25rem; aspect-ratio: 1047 \/ 820/);
  const svg = await readFile('public/brand/atlas-icon.svg', 'utf8');
  assert.ok(svg.includes('fill="#000000"'));
  assert.ok(!svg.includes('--atlas-accent'));
  assert.ok(!svg.includes('#35E6D0'));
});
