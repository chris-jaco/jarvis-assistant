import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { AtlasOrb, orbEnergy, stateLabels, presentationState } from './orb.js';
import { Transcript } from './transcript.js';
import { ConfirmationDialog } from './confirmation-dialog.js';
import { ASSISTANT_NAME, JARVIS_INSTRUCTIONS } from '../core/personality.js';
const document = () => new JSDOM('<button id="before">Start</button><div id="orb"></div><div id="scroll"><ol id="transcript"></ol></div><dialog><p id="summary"></p><p id="status"></p><button id="yes">Yes</button><button id="no">No</button></dialog>').window.document as unknown as Document;
export function dialogFixture(decide: (approved: boolean, id: string) => void) {
  const doc = document(); const dialog = doc.querySelector('dialog')!;
  dialog.showModal = () => { dialog.setAttribute('open', ''); }; dialog.close = () => { dialog.removeAttribute('open'); };
  const yes = doc.querySelector<HTMLButtonElement>('#yes')!; const no = doc.querySelector<HTMLButtonElement>('#no')!;
  const ui = new ConfirmationDialog(dialog, doc.querySelector('#summary')!, doc.querySelector('#status')!, yes, no, decide);
  return { doc, dialog, get yes() { return doc.querySelector<HTMLButtonElement>('#yes')!; }, get no() { return doc.querySelector<HTMLButtonElement>('#no')!; }, ui };
}
test('Atlas identity replaces public name while legacy backend configuration and private paths remain compatible', async () => {
  assert.equal(ASSISTANT_NAME, 'Atlas'); assert.match(JARVIS_INSTRUCTIONS, /Eres Atlas/); assert.ok(!/JARVIS|Christian/.test(JARVIS_INSTRUCTIONS));
  const html = await readFile('index.html', 'utf8'); assert.match(html, /<title>Atlas/); assert.ok(!html.includes('JARVIS')); assert.match(html, /<dialog/);
  const server = await readFile('src/server/index.ts', 'utf8'); assert.match(server, /ATLAS: http/);
  const config = await readFile('src/server/tools.ts', 'utf8'); assert.ok(config.includes('JARVIS_CONFIRMATION_TRACE')); assert.ok(config.includes('JARVIS_MEMORY_PROFILE'));
  const store = await readFile('src/memory/store.ts', 'utf8'); assert.ok(store.includes('.local/memory/memories.json'));
});
test('orb routes actual microphone/playback levels by lifecycle state; reduced motion retains energy feedback', () => {
  assert.equal(presentationState('connected', true), 'thinking'); assert.equal(presentationState('listening', true), 'listening'); assert.equal(presentationState('speaking', true), 'speaking');
  assert.equal(orbEnergy('listening', .3, .9), .3); assert.equal(orbEnergy('speaking', .3, .9), .9);
  for (const state of ['connected', 'disconnected', 'error', 'thinking', 'connecting'] as const) { assert.equal(orbEnergy(state, .8, .9), 0); assert.ok(stateLabels[state]); }
  assert.equal(orbEnergy('listening', 8, 0), 1); assert.equal(orbEnergy('speaking', 0, NaN), 0);
  const doc = document(); const element = doc.querySelector<HTMLElement>('#orb')!; let change: (() => void) | undefined; let removed = false;
  const query = { matches: false, addEventListener: (_: string, fn: () => void) => { change = fn; }, removeEventListener: () => { removed = true; } } as unknown as MediaQueryList;
  const orb = new AtlasOrb(element, query); orb.update('listening'); orb.levels(.4, .8); assert.equal(element.style.getPropertyValue('--energy'), '0.400');
  Object.defineProperty(query, 'matches', { value: true }); change!(); assert.equal(element.dataset.reducedMotion, 'true'); assert.equal(element.style.getPropertyValue('--energy'), '0.400');
  orb.update('speaking'); orb.levels(.2, .6); assert.equal(element.dataset.state, 'speaking'); assert.equal(element.style.getPropertyValue('--energy'), '0.600');
  orb.dispose(); assert.equal(removed, true);
});
test('transcript updates partial/final turns in place, renders Atlas and literal text without HTML, and preserves manual scroll', () => {
  const doc = document(); const list = doc.querySelector<HTMLElement>('#transcript')!; const scroll = doc.querySelector<HTMLElement>('#scroll')!;
  Object.defineProperties(scroll, { scrollHeight: { value: 1000 }, clientHeight: { value: 200 } }); scroll.scrollTop = 800;
  const transcript = new Transcript(list, scroll); transcript.update([{ id: 'u', role: 'user', text: 'Hola' }]); const first = list.firstChild;
  assert.equal(scroll.scrollTop, 1000); scroll.scrollTop = 10;
  transcript.update([{ id: 'u', role: 'user', text: 'Hola Atlas' }, { id: 'a', role: 'assistant', text: '<img onerror="bad">Te escucho.' }]);
  assert.equal(list.firstChild, first); assert.equal(scroll.scrollTop, 10); assert.equal(list.querySelectorAll('img').length, 0);
  assert.ok(list.textContent!.includes('Tú')); assert.ok(list.textContent!.includes('Atlas')); assert.ok(list.textContent!.includes('Hola Atlas'));
  transcript.update([]); assert.equal(list.children.length, 0); assert.ok(list.hasAttribute('data-empty'));
});
test('dialog uses only frozen summary; confirms once, waits for backend, closes on voice resolution and restores focus', () => {
  const decisions: unknown[] = []; const f = dialogFixture((approved, id) => decisions.push([approved, id]));
  try {
    f.doc.querySelector<HTMLElement>('#before')!.focus();
    f.ui.update({ confirmationId: 'frozen', summary: '¿Confirmás esta acción? <img src=x>', expiresAt: Date.now() + 60000, privatePayload: 'never render' } as never);
    assert.equal(f.dialog.open, true); assert.equal(f.doc.activeElement, f.no); assert.equal(f.dialog.querySelectorAll('img').length, 0); assert.ok(!f.dialog.textContent!.includes('never render'));
    f.yes.click(); f.yes.click(); assert.deepEqual(decisions, [[true, 'frozen']]); assert.equal(f.dialog.open, true);
    f.ui.update(null); assert.equal(f.dialog.open, false); assert.equal(f.doc.activeElement!.id, 'before'); f.yes.click(); assert.equal(decisions.length, 1);
  } finally { f.ui.dispose(); }
});
test('Cancel and Escape reject the current pending ID; expired and disposed dialogs cannot decide', () => {
  const decisions: unknown[] = []; const f = dialogFixture((approved, id) => decisions.push([approved, id]));
  try {
    f.ui.update({ confirmationId: 'cancel', summary: 'Frozen', expiresAt: Date.now() + 60000 }); f.no.click(); assert.deepEqual(decisions, [[false, 'cancel']]);
    f.ui.update({ confirmationId: 'escape', summary: 'Frozen', expiresAt: Date.now() + 60000 });
    const event = new f.doc.defaultView!.Event('cancel', { cancelable: true }); f.dialog.dispatchEvent(event); assert.equal(event.defaultPrevented, true); assert.deepEqual(decisions[1], [false, 'escape']);
    f.ui.update({ confirmationId: 'expired', summary: 'Frozen', expiresAt: Date.now() - 1 }); f.yes.click(); assert.equal(decisions.length, 2);
  } finally { f.ui.dispose(); }
  f.yes.click(); assert.equal(decisions.length, 2);
});

test('buttons from a resolved dialog cannot approve a later pending action', () => {
  const decisions: unknown[] = []; const f = dialogFixture((approved, id) => decisions.push([approved, id]));
  try {
    f.ui.update({ confirmationId: 'old', summary: 'Old', expiresAt: Date.now() + 60000 }); const oldButton = f.yes;
    f.ui.update(null); f.ui.update({ confirmationId: 'new', summary: 'New', expiresAt: Date.now() + 60000 });
    oldButton.click(); assert.equal(decisions.length, 0); f.yes.click(); assert.deepEqual(decisions, [[true, 'new']]);
  } finally { f.ui.dispose(); }
});
