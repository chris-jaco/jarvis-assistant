import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import {
  CREDENTIAL_DELETE_OPENAI_CHANNEL,
  CREDENTIAL_PROVISION_OPENAI_CHANNEL,
  CREDENTIAL_STATUS_CHANNEL
} from '../desktop/credential-setup-api.js';
import type { AtlasCredentialSetupApi, CredentialSetupResult } from '../desktop/credential-setup-api.js';
import { registerCredentialSetupIpc } from '../desktop/credential-setup-ipc.js';
import { DesktopCredentialStoreError } from '../desktop/credential-store.js';
import { mountCredentialSetup } from '../desktop/credential-setup/renderer.js';

const root = resolve(import.meta.dirname, '../..');
const flush = () => new Promise<void>(resolveFlush => setImmediate(resolveFlush));

function ipcFixture(state: 'MISSING' | 'CONFIGURED' | 'INVALID' = 'MISSING') {
  const handlers = new Map<string, Function>(); let current = state; let stored = ''; let writes = 0; let deletes = 0;
  const ipc = {
    handle: (channel: string, handler: Function) => handlers.set(channel, handler),
    removeHandler: (channel: string) => handlers.delete(channel)
  };
  const store = {
    async status() { return { OPENAI_API_KEY: current, GOOGLE_CLIENT_ID: 'MISSING', GOOGLE_CLIENT_SECRET: 'MISSING' } as const; },
    async set(_id: 'OPENAI_API_KEY', value: string) { writes++; if (value === 'FAIL') throw new DesktopCredentialStoreError('CREDENTIAL_STORAGE_UNAVAILABLE'); stored = value; current = 'CONFIGURED'; },
    async delete() { deletes++; stored = ''; current = 'MISSING'; }
  };
  const controller = registerCredentialSetupIpc(ipc as never, store as never, sender => sender === 7);
  const call = (channel: string, sender: number, value?: unknown) => handlers.get(channel)!({ sender: { id: sender } }, value) as Promise<CredentialSetupResult>;
  return { handlers, controller, call, counts: () => ({ writes, deletes, stored }) };
}

test('credential IPC exposes only status, provision and delete with no read or generic secret operation', async () => {
  const f = ipcFixture();
  assert.deepEqual([...f.handlers.keys()].sort(), [CREDENTIAL_DELETE_OPENAI_CHANNEL, CREDENTIAL_PROVISION_OPENAI_CHANNEL, CREDENTIAL_STATUS_CHANNEL].sort());
  assert.equal(await f.call(CREDENTIAL_STATUS_CHANNEL, 7).then(result => result.state), 'MISSING');
  assert.equal(await f.call(CREDENTIAL_PROVISION_OPENAI_CHANNEL, 7, 'private-fixture-key').then(result => result.state), 'CONFIGURED');
  assert.equal(f.counts().stored, 'private-fixture-key');
  assert.equal(await f.call(CREDENTIAL_PROVISION_OPENAI_CHANNEL, 7, 'replacement-fixture-key').then(result => result.state), 'CONFIGURED');
  assert.equal(f.counts().stored, 'replacement-fixture-key');
  assert.equal(await f.call(CREDENTIAL_DELETE_OPENAI_CHANNEL, 7).then(result => result.state), 'MISSING');
  assert.deepEqual(f.counts(), { writes: 2, deletes: 1, stored: '' });
  f.controller.dispose(); assert.equal(f.handlers.size, 0);
});

test('credential IPC rejects untrusted senders, invalid payloads and encryption failures without raw errors', async () => {
  const f = ipcFixture();
  const unauthorized = await f.call(CREDENTIAL_PROVISION_OPENAI_CHANNEL, 8, 'private-must-not-store');
  assert.deepEqual(unauthorized, { ok: false, state: 'INVALID', error: 'OPERATION_FAILED' });
  assert.deepEqual(f.counts(), { writes: 0, deletes: 0, stored: '' });
  assert.deepEqual(await f.call(CREDENTIAL_PROVISION_OPENAI_CHANNEL, 7, { key: 'private' }), { ok: false, state: 'INVALID', error: 'INVALID_VALUE' });
  const failed = await f.call(CREDENTIAL_PROVISION_OPENAI_CHANNEL, 7, 'FAIL');
  assert.deepEqual(failed, { ok: false, state: 'INVALID', error: 'STORAGE_UNAVAILABLE' });
  assert.ok(!JSON.stringify(failed).includes('private'));
});

function rendererFixture(initial: CredentialSetupResult) {
  const dom = new JSDOM(`<!doctype html><form id="credential-form"><input id="api-key"><button id="save"></button></form><button id="clear"></button><button id="delete"></button><button id="continue" hidden></button><p id="status"></p>`);
  const calls: string[] = []; let state = initial; let closed = 0;
  const api: AtlasCredentialSetupApi = {
    async status() { calls.push('status'); return state; },
    async provisionOpenAI(value) { calls.push(`set:${value}`); state = { ok: true, state: 'CONFIGURED' }; return state; },
    async deleteOpenAI() { calls.push('delete'); state = { ok: true, state: 'MISSING' }; return state; }
  };
  const previousConfirm = globalThis.confirm; globalThis.confirm = () => true;
  const dispose = mountCredentialSetup(dom.window.document, api, () => { closed++; });
  return { dom, calls, dispose: () => { dispose(); globalThis.confirm = previousConfirm; }, closed: () => closed };
}

test('setup renderer shows MISSING/CONFIGURED/INVALID, clears fields and advances only after explicit continue', async () => {
  for (const initial of [
    { ok: true, state: 'MISSING' },
    { ok: true, state: 'CONFIGURED' },
    { ok: false, state: 'INVALID', error: 'STORE_INVALID' }
  ] as CredentialSetupResult[]) {
    const f = rendererFixture(initial);
    try { await flush(); assert.match(f.dom.window.document.querySelector('#status')!.textContent!, new RegExp(initial.state)); }
    finally { f.dispose(); }
  }
  const f = rendererFixture({ ok: true, state: 'MISSING' });
  try {
    await flush();
    const input = f.dom.window.document.querySelector<HTMLInputElement>('#api-key')!;
    input.value = 'private-user-entry';
    f.dom.window.document.querySelector('form')!.dispatchEvent(new f.dom.window.Event('submit', { bubbles: true, cancelable: true }));
    await flush();
    assert.equal(input.value, ''); assert.equal(f.closed(), 0);
    f.dom.window.document.querySelector<HTMLButtonElement>('#continue')!.click();
    assert.equal(f.closed(), 1);
    f.dom.window.document.querySelector<HTMLButtonElement>('#delete')!.click();
    await flush(); assert.equal(input.value, '');
  } finally { f.dispose(); }
});

test('local setup resources prohibit persistence, network and secret reads; packaged gate precedes Core startup', () => {
  const html = readFileSync(resolve(root, 'src/desktop/credential-setup/index.html'), 'utf8');
  const renderer = readFileSync(resolve(root, 'src/desktop/credential-setup/renderer.ts'), 'utf8');
  const preload = readFileSync(resolve(root, 'src/desktop/credential-setup-preload.ts'), 'utf8');
  const main = readFileSync(resolve(root, 'src/desktop/main.ts'), 'utf8');
  assert.match(html, /connect-src 'none'/); assert.match(html, /type="password"/);
  assert.doesNotMatch(`${renderer}\n${preload}`, /localStorage|sessionStorage|credentials\.read/);
  assert.doesNotMatch(preload, /core-request|realtime-token|readFile|fetch/);
  assert.match(main, /Menu\.setApplicationMenu\(null\)/);
  assert.match(readFileSync(resolve(root, 'src/desktop/credential-setup-window.ts'), 'utf8'), /devTools: false/);
  assert.ok(main.indexOf('runCredentialSetupWindow') < main.indexOf('supervisor = new BackendSupervisor'));
  assert.match(main, /paths\.mode === 'PACKAGED'/);
  assert.match(main, /if \(!configured\).*app\.quit\(\).*return/s);
});
