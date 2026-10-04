import { fakeIntent, naturalApprovals } from './testing/confirmation-intent.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RunContext } from '@openai/agents-core';
import { VoiceToolBridge } from '../provider/tools.js';
import { simpleParser } from 'mailparser';
import { GmailAdapter } from './adapters/gmail.js';
import { gmailAccountId } from './adapters/gmail-accounts.js';
import type { GmailAccounts, GmailAccount } from './adapters/gmail-accounts.js';
import { GoogleGmailTransport } from './adapters/gmail-transport.js';
import type { GmailTransport } from './adapters/gmail-transport.js';
import type { GmailMessage } from './adapters/gmail-content.js';
import { compileMail, decodeData } from './adapters/gmail-content.js';
import { ToolRegistry } from './registry.js';
import { ToolExecutor } from './execution.js';
import { ToolError } from './types.js';
const A = gmailAccountId('account-a'), B = gmailAccountId('account-b');
const ownerA = { id: A, email: 'owner@example.test', label: 'First' }, ownerB = { id: B, email: 'other@example.test', label: 'Second' };
class FakeAccounts implements GmailAccounts {
  constructor(public values: GmailAccount[] = [ownerA, ownerB]) {}
  async list() { return this.values; }
  async get(id?: string) {
    if (!id && this.values.length > 1) throw new ToolError('AMBIGUOUS');
    const value = id ? this.values.find(a => a.id === id) : this.values[0];
    if (!value) throw new ToolError('UNCONFIGURED'); return value;
  }
  async token(id: string) { await this.get(id); return id === A ? 'fake-token-a' : 'fake-token-b'; }
}
function message(id = 'm1', received = 'team@example.test'): GmailMessage {
  return { id, threadId: 't1', labelIds: ['INBOX', 'UNREAD'], payload: { partId: '', mimeType: 'multipart/mixed', headers: [
    { name: 'From', value: 'Sender <sender@example.test>' }, { name: 'To', value: `Team <${received}>` }, { name: 'Cc', value: 'Colleague <colleague@example.test>' },
    { name: 'Delivered-To', value: ownerA.email }, { name: 'Subject', value: 'Meeting' }, { name: 'Message-ID', value: '<source@example.test>' }, { name: 'References', value: '<earlier@example.test>' },
    { name: 'Date', value: 'Mon, 5 Oct 2026 10:00:00 +0200' }
  ], parts: [ { partId: '0', mimeType: 'text/plain', body: { data: Buffer.from('Please confirm Tuesday.').toString('base64url'), size: 23 } },
    { partId: '1', mimeType: 'text/plain', filename: 'note.txt', body: { attachmentId: 'a1', size: 3 } } ] } };
}
class FakeApi implements GmailTransport {
  calls: Array<{ accountId: string; method: string; path: string; body: unknown }> = [];
  aliasA = [{ sendAsEmail: ownerA.email, isPrimary: true }, { sendAsEmail: 'team@example.test', verificationStatus: 'accepted' }, { sendAsEmail: 'pending@example.test', verificationStatus: 'pending' }];
  draftRaw = ''; messageValue = message(); failAccount?: string; sendFailure = false; changedDraft = false;
  async request(accountId: string, method: string, path: string, body: unknown, _signal: AbortSignal): Promise<unknown> {
    this.calls.push({ accountId, method, path, body: structuredClone(body) });
    if (accountId === this.failAccount) throw new Error('private upstream OAuth credential');
    if (path === 'settings/sendAs') return { sendAs: accountId === A ? this.aliasA : [{ sendAsEmail: ownerB.email, isPrimary: true }] };
    if (method === 'GET' && path.startsWith('messages?')) return { messages: [{ id: 'm1' }], ...(path.includes('pageToken') ? {} : { nextPageToken: 'next' }) };
    if (method === 'GET' && path.includes('/attachments/')) return { data: Buffer.from('abc').toString('base64url'), size: 3 };
    if (method === 'GET' && path.startsWith('messages/')) return { ...structuredClone(this.messageValue), id: path.split('/')[1]!.split('?')[0] };
    if (path.startsWith('threads/')) return { id: 't1', messages: [structuredClone(this.messageValue), message('m2')] };
    if (path.startsWith('drafts/') && method === 'GET') return { id: 'd1', message: { id: 'dm1', threadId: 't1', raw: this.changedDraft ? 'changed' : this.draftRaw } };
    if (path === 'drafts' || method === 'PUT' && path.startsWith('drafts/')) return { id: 'd1', message: { id: 'dm1', threadId: 't1' } };
    if (path === 'labels') return { labels: [{ id: 'INBOX' }, { id: 'UNREAD' }, { id: 'TRASH' }, { id: 'Label_1' }] };
    if (path === 'messages/send') { if (this.sendFailure) throw new Error('secret send outcome uncertain'); return { id: 'sent1', threadId: 't1' }; }
    if (path.endsWith('/modify') || path.endsWith('/trash')) return { id: 'm1' };
    throw new Error('Unexpected fake route');
  }
  mutations() { return this.calls.filter(c => c.method !== 'GET'); }
}
function fixture(confirm = false, onlyA = false) {
  const accounts = new FakeAccounts(onlyA ? [ownerA] : undefined), api = new FakeApi(), registry = new ToolRegistry();
  registry.add(new GmailAdapter(accounts, api, 'Europe/Madrid', confirm)); let now = Date.now();
  const executor = new ToolExecutor(registry, () => now); let sequence = 0;
  return { accounts, api, registry, executor, invoke: (id: string, input: unknown) => executor.invoke(String(++sequence), id, input), expire: () => { now += 60_001; } };
}
const outgoing = { accountId: A, from: ownerA.email, to: ['recipient@example.test'], cc: ['cc@example.test'], bcc: ['bcc@example.test'], subject: 'Test', body: 'A test message.', operation: 'new' };
test('Gmail READ tools search all accounts or only the explicit account, return stable IDs and disclose partial pages', async () => {
  const f = fixture(); const all = await f.invoke('gmail.search', { sender: 'sender@example.test', mailbox: 'inbox' });
  assert.equal(all.status, 'success'); if (all.status !== 'success') throw new Error();
  const data = all.data as { accounts: Array<{ accountId: string; messages: Array<{ threadId: string }> }>; partial: boolean };
  assert.deepEqual(data.accounts.map(a => a.accountId), [A, B]); assert.equal(data.accounts[0]!.messages[0]!.threadId, 't1'); assert.equal(data.partial, true);
  assert.ok(f.api.calls.some(c => c.path.includes('labelIds=INBOX'))); assert.equal(f.api.mutations().length, 0);
  f.api.calls = []; await f.invoke('gmail.search', { accountId: B, mailbox: 'sent', query: 'subject:meeting', pageTokens: { [B]: 'next' } });
  assert.ok(f.api.calls.every(c => c.accountId === B)); assert.ok(f.api.calls.some(c => c.path.includes('labelIds=SENT')));
});
test('global search identifies failed accounts safely and date ranges use explicit user timezone', async () => {
  const f = fixture(); f.api.failAccount = B;
  const r = await f.invoke('gmail.search', { startDate: '2026-10-05', endDate: '2026-10-06' });
  assert.equal(r.status, 'success'); assert.ok(!JSON.stringify(r).includes('private upstream'));
  const query = new URL(`https://example.test/${f.api.calls.find(c => c.path.startsWith('messages?'))!.path}`).searchParams.get('q')!;
  assert.ok(query.includes(`after:${Date.parse('2026-10-04T22:00:00Z') / 1000}`));
  assert.equal((await f.invoke('gmail.search', { startDate: '2026-02-30', endDate: '2026-03-01' })).status, 'error');
});
test('ambiguous account and missing explicit message IDs cannot mutate or guess a thread', async () => {
  const f = fixture();
  const r = await f.invoke('gmail.getMessage', { messageId: 'm1' }); assert.equal(r.status, 'error'); if (r.status === 'error') assert.equal(r.category, 'AMBIGUOUS');
  assert.equal((await f.invoke('gmail.send', { ...outgoing, accountId: undefined })).status, 'error');
  assert.equal((await f.invoke('gmail.send', { ...outgoing, operation: 'reply', messageId: undefined })).status, 'error'); assert.equal(f.api.mutations().length, 0);
});
test('messages/complete threads expose account-bound attachment metadata; safe retrieval returns text but never binary', async () => {
  const f = fixture(); const r = await f.invoke('gmail.getMessage', { accountId: A, messageId: 'm1' }); assert.equal(r.status, 'success'); if (r.status !== 'success') throw new Error();
  const view = r.data as { text: string; attachments: Array<{ accountId: string; messageId: string; partId: string; filename: string }> };
  assert.equal(view.text, 'Please confirm Tuesday.'); assert.equal(view.attachments[0]!.filename, 'note.txt'); assert.equal(view.attachments[0]!.accountId, A);
  const file = await f.invoke('gmail.inspectAttachment', { ref: { accountId: A, messageId: 'm1', partId: '1' }, extractText: true });
  assert.equal(file.status, 'success'); if (file.status === 'success') { assert.equal((file.data as { text: string }).text, 'abc'); assert.ok(!('data' in (file.data as object))); }
  const thread = await f.invoke('gmail.getThread', { accountId: A, threadId: 't1' }); assert.equal(thread.status, 'success');
  assert.equal(f.api.mutations().length, 0);
  assert.equal((await f.invoke('gmail.inspectAttachment', { ref: { accountId: A, messageId: '../m1', partId: '1' } })).status, 'error');
  f.api.messageValue.payload!.parts![1]!.body!.size = 9 * 1024 * 1024;
  assert.equal((await f.invoke('gmail.inspectAttachment', { ref: { accountId: A, messageId: 'm1', partId: '1' } })).status, 'error');
});
test('unverified/spoofed From is rejected; multiple aliases require clarification; reply selects received identity', async () => {
  const f = fixture();
  for (const from of ['spoof@example.test', 'pending@example.test', undefined]) assert.equal((await f.invoke('gmail.send', { ...outgoing, from })).status, 'error');
  const r = await f.invoke('gmail.send', { accountId: A, operation: 'replyAll', messageId: 'm1', body: 'Tuesday at 15 works.' });
  assert.equal(r.status, 'pending'); if (r.status !== 'pending') throw new Error();
  assert.ok(r.summary.includes('team@example.test')); assert.ok(r.summary.includes('colleague@example.test')); assert.equal(f.api.mutations().length, 0);
  await f.executor.decide(r.confirmationId, true);
  const mail = await simpleParser(decodeData((f.api.mutations()[0]!.body as { raw: string }).raw, 12 * 1024 * 1024));
  assert.equal(mail.from!.value[0]!.address, 'team@example.test'); assert.equal(mail.inReplyTo, '<source@example.test>'); assert.equal(mail.subject, 'Re: Meeting');
});
test('ambiguous reply identity asks instead of selecting a default alias or guessing recipients', async () => {
  const f = fixture(); f.api.messageValue.payload!.headers!.find(h => h.name === 'To')!.value = `${ownerA.email}, team@example.test`;
  const r = await f.invoke('gmail.send', { accountId: A, operation: 'reply', messageId: 'm1', body: 'OK' }); assert.equal(r.status, 'error'); if (r.status === 'error') assert.equal(r.category, 'AMBIGUOUS'); assert.equal(f.api.mutations().length, 0);
});
test('SEND is always SENSITIVE, freezes all content and addresses, executes once, and keeps private body out of telemetry', async () => {
  const f = fixture(false); const input = structuredClone(outgoing);
  const r = await f.invoke('gmail.send', input); assert.equal(r.status, 'pending'); assert.equal(f.api.mutations().length, 0); if (r.status !== 'pending') throw new Error();
  assert.ok(r.summary.includes('bcc@example.test')); input.body = 'Changed after preparation'; input.to = ['changed@example.test'];
  const results = await Promise.all([f.executor.decide(r.confirmationId, true), f.executor.decide(r.confirmationId, true)]);
  assert.equal(results.filter(r => r.status === 'success').length, 1); assert.equal(f.api.mutations().length, 1);
  const raw = (f.api.mutations()[0]!.body as { raw: string }).raw; const parsed = await simpleParser(decodeData(raw, 12 * 1024 * 1024));
  assert.ok(parsed.text!.includes(outgoing.body)); assert.equal((Array.isArray(parsed.bcc) ? parsed.bcc[0] : parsed.bcc)!.value[0]!.address, 'bcc@example.test');
  assert.ok(!JSON.stringify(f.executor.telemetry.snapshot()).includes(outgoing.body));
  // A repeated model call with a different invocation ID still cannot resend identical content.
  const repeated = await f.invoke('gmail.send', outgoing); if (repeated.status !== 'pending') throw new Error(); await f.executor.decide(repeated.confirmationId, true); assert.equal(f.api.mutations().length, 1);
});
test('negative, expired, old and closed confirmations cannot send', async () => {
  for (const mode of ['negative', 'expired', 'replaced', 'closed']) {
    const f = fixture(); const r = await f.invoke('gmail.send', outgoing); if (r.status !== 'pending') throw new Error();
    if (mode === 'expired') f.expire(); if (mode === 'replaced') await f.invoke('gmail.accounts', {}); if (mode === 'closed') f.executor.close();
    await f.executor.decide(r.confirmationId, mode !== 'negative'); assert.equal(f.api.mutations().length, 0);
  }
});
test('uncertain send failure is normalized and never retried under another call ID', async () => {
  const f = fixture(); f.api.sendFailure = true;
  for (let i = 0; i < 2; i++) { const r = await f.invoke('gmail.send', outgoing); if (r.status !== 'pending') throw new Error(); const d = await f.executor.decide(r.confirmationId, true); assert.equal(d.status, 'error'); assert.ok(!JSON.stringify(d).includes('secret')); }
  assert.equal(f.api.mutations().length, 1);
});
test('forward freezes attachment bytes and original body; cross-account attachment refs are rejected', async () => {
  const f = fixture(); const r = await f.invoke('gmail.send', { accountId: A, from: ownerA.email, operation: 'forward', messageId: 'm1', to: ['recipient@example.test'], body: 'See below.' });
  assert.equal(r.status, 'pending'); if (r.status !== 'pending') throw new Error(); assert.ok(r.summary.includes('note.txt')); assert.equal(f.api.mutations().length, 0);
  f.api.messageValue.payload!.parts![1]!.body!.size = 999;
  await f.executor.decide(r.confirmationId, true);
  const mail = await simpleParser(decodeData((f.api.mutations()[0]!.body as { raw: string }).raw, 12 * 1024 * 1024)); assert.equal(mail.attachments[0]!.content.toString(), 'abc'); assert.ok(mail.text!.includes('Please confirm Tuesday.'));
  assert.equal((await f.invoke('gmail.send', { ...outgoing, attachments: [{ accountId: B, messageId: 'm1', partId: '1' }] })).status, 'error');
});
test('draft creation never sends; WRITE policy works; edited prepared draft fails before send/update', async () => {
  const f = fixture(true); const draft = await f.invoke('gmail.createDraft', outgoing); assert.equal(draft.status, 'pending'); assert.equal(f.api.mutations().length, 0); if (draft.status !== 'pending') throw new Error();
  await f.executor.decide(draft.confirmationId, true); assert.equal(f.api.mutations()[0]!.path, 'drafts');
  f.api.draftRaw = await compileMail({ from: ownerA.email, to: outgoing.to, cc: outgoing.cc, bcc: outgoing.bcc, subject: 'Draft', body: 'Frozen draft body' }, []);
  for (const id of ['gmail.sendDraft', 'gmail.updateDraft']) {
    f.api.changedDraft = false;
    const r = await f.invoke(id, id === 'gmail.sendDraft' ? { accountId: A, draftId: 'd1' } : { ...outgoing, draftId: 'd1' }); assert.equal(r.status, 'pending'); if (r.status !== 'pending') throw new Error();
    f.api.changedDraft = true; const d = await f.executor.decide(r.confirmationId, true); assert.equal(d.status, 'error'); if (d.status === 'error') assert.equal(d.category, 'CONFLICT');
  }
  assert.equal(f.api.mutations().length, 1);
});
test('sending a prepared draft retains its frozen account/identity and never sends changed bytes', async () => {
  const f = fixture(); f.api.draftRaw = await compileMail({ from: ownerA.email, to: outgoing.to, cc: [], bcc: outgoing.bcc, subject: 'Draft', body: 'Draft body' }, []);
  const r = await f.invoke('gmail.sendDraft', { accountId: A, draftId: 'd1' }); assert.equal(r.status, 'pending'); if (r.status !== 'pending') throw new Error();
  const d = await f.executor.decide(r.confirmationId, true); assert.equal(d.status, 'success'); assert.equal(f.api.mutations()[0]!.accountId, A); const mail = await simpleParser(decodeData((f.api.mutations()[0]!.body as { raw: string }).raw, 12 * 1024 * 1024)); assert.equal(mail.from!.value[0]!.address, ownerA.email); assert.ok(mail.text!.includes('Draft body')); assert.equal((Array.isArray(mail.bcc) ? mail.bcc[0] : mail.bcc)!.value[0]!.address, 'bcc@example.test');
});
test('archive/mark read use WRITE policy; trash always confirms and permanent deletion is absent', async () => {
  const f = fixture(); assert.equal((await f.invoke('gmail.modifyMessage', { accountId: A, messageId: 'm1', removeLabels: ['INBOX', 'UNREAD'] })).status, 'success');
  const r = await f.invoke('gmail.trashMessage', { accountId: A, messageId: 'm1' }); assert.equal(r.status, 'pending'); assert.equal(f.api.mutations().length, 1);
  assert.equal(f.registry.resolve('gmail.deleteMessage'), undefined);
  assert.equal((await f.invoke('gmail.modifyMessage', { accountId: A, messageId: 'm1', addLabels: ['TRASH'] })).status, 'error');
});
test('Gmail transport isolates bearer credentials, makes one request, and discards upstream secret details', async () => {
  const accounts = new FakeAccounts(); const observed: string[] = [];
  const api = new GoogleGmailTransport(accounts, async (_url, options) => { observed.push(new Headers(options?.headers).get('Authorization')!); return Response.json({ id: 'm1' }); });
  await api.request(A, 'GET', 'profile', undefined, new AbortController().signal); await api.request(B, 'GET', 'profile', undefined, new AbortController().signal);
  assert.deepEqual(observed, ['Bearer fake-token-a', 'Bearer fake-token-b']);
  let count = 0; const failing = new GoogleGmailTransport(accounts, async () => { count++; return new Response('secret-token', { status: 500 }); });
  await assert.rejects(failing.request(A, 'POST', 'messages/send', {}, new AbortController().signal), e => e instanceof ToolError && !e.message.includes('secret-token')); assert.equal(count, 1);
});

test('Gmail through real voice bridge: stale yes cannot send; post-prompt confirmation/negative preserve account binding', async () => {
  const original = globalThis.fetch; const f = fixture(); const decisions: boolean[] = [];
  globalThis.fetch = async (url, options) => {
    const route = String(url).split('/').pop(); const input = options?.body ? JSON.parse(String(options.body)) : {};
    if (route === 'session') return Response.json({ tools: f.registry.descriptors(), timezone: 'Europe/Madrid', now: new Date().toISOString() });
    if (route === 'invoke') return Response.json(await f.executor.invoke(input.invocationId, input.toolId, input.input));
    if (route === 'activity') return Response.json({ activity: f.executor.telemetry.snapshot(), pending: f.executor.pendingState() });
    if (route === 'cancel') { f.executor.invalidate(); return Response.json({ cancelled: true }); }
    if (route === 'intent') return Response.json({ confirmationId: input.confirmationId, intent: fakeIntent(input.utterance) });
    if (route === 'decision') { decisions.push(input.approved); return Response.json(await f.executor.decide(input.confirmationId, input.approved)); }
    throw new Error('Unexpected route');
  };
  const bridge = new VoiceToolBridge(() => {}, () => {});
  try {
    const config = await bridge.initialize(); const sdkTool = config.tools.find(tool => tool.name === 'gmail_send')!;
    await sdkTool.invoke(new RunContext(), JSON.stringify({ inputJson: JSON.stringify(outgoing) }));
    await bridge.transportEvent({ type: 'response.created', response: { id: 'gmail-prompt' } });
    await bridge.transportEvent({ type: 'input_audio_buffer.speech_started', item_id: 'early' });
    await bridge.transportEvent({ type: 'output_audio_buffer.stopped', response_id: 'gmail-prompt' });
    await bridge.transportEvent({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'early', transcript: 'Sí, confirmo.' });
    assert.equal(f.api.mutations().length, 0); assert.deepEqual(decisions, []);
    await bridge.transportEvent({ type: 'input_audio_buffer.speech_started', item_id: 'eligible' });
    await bridge.transportEvent({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'eligible', transcript: 'Sí, confirmo.' });
    assert.equal(f.api.mutations().length, 1); assert.equal(f.api.mutations()[0]!.accountId, A); assert.deepEqual(decisions, [true]);
    await sdkTool.invoke(new RunContext(), JSON.stringify({ inputJson: JSON.stringify({ ...outgoing, body: 'Another message' }) }));
    await bridge.transportEvent({ type: 'input_audio_buffer.speech_started', item_id: 'reject' });
    await bridge.transportEvent({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'reject', transcript: 'No.' });
    assert.equal(f.api.mutations().length, 1); assert.deepEqual(decisions, [true, false]);
  } finally { bridge.close(); f.executor.close(); globalThis.fetch = original; }
});

test('HTML drafts are converted to reviewed plain text and frozen; spoofing/duplicate envelope headers are refused', async () => {
  const f = fixture();
  f.api.draftRaw = Buffer.from(`From: ${ownerA.email}\r\nTo: recipient@example.test\r\nSubject: HTML draft\r\nMIME-Version: 1.0\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<p>Tuesday works.</p><img src="https://example.test/tracker">`).toString('base64url');
  const r = await f.invoke('gmail.sendDraft', { accountId: A, draftId: 'd1' }); assert.equal(r.status, 'pending'); if (r.status !== 'pending') throw new Error();
  assert.ok(r.summary.includes('Tuesday works.')); await f.executor.decide(r.confirmationId, true);
  const parsed = await simpleParser(decodeData((f.api.mutations()[0]!.body as { raw: string }).raw, 12 * 1024 * 1024), { skipTextToHtml: true });
  assert.ok(parsed.text!.includes('Tuesday works.')); assert.equal(parsed.html, false);
  for (const header of [`From: spoof@example.test\r\nFrom: ${ownerA.email}`, `From: ${ownerA.email}\r\nResent-To: hidden@example.test`]) {
    f.api.draftRaw = Buffer.from(`${header}\r\nTo: recipient@example.test\r\nSubject: unsafe\r\n\r\nbody`).toString('base64url');
    assert.equal((await f.invoke('gmail.sendDraft', { accountId: A, draftId: 'd1' })).status, 'error');
  }
  assert.equal(f.api.mutations().length, 1);
});
test('account and alias revocation before approval fail without sending; draft WRITE opt-out still never sends', async () => {
  for (const mode of ['account', 'alias']) {
    const f = fixture(); const r = await f.invoke('gmail.send', outgoing); if (r.status !== 'pending') throw new Error();
    if (mode === 'account') f.accounts.values = [ownerB]; else f.api.aliasA = [];
    assert.equal((await f.executor.decide(r.confirmationId, true)).status, 'error'); assert.equal(f.api.mutations().length, 0);
  }
  const f = fixture(false); assert.equal((await f.invoke('gmail.createDraft', outgoing)).status, 'success');
  assert.ok(f.api.mutations().every(c => c.path === 'drafts'));
});

test('reply to our own Sent message targets original recipients and preserves sending alias/thread', async () => {
  const f = fixture(); f.api.messageValue.labelIds = ['SENT'];
  f.api.messageValue.payload!.headers!.find(h => h.name === 'From')!.value = ownerA.email;
  f.api.messageValue.payload!.headers!.find(h => h.name === 'To')!.value = 'recipient@example.test';
  const r = await f.invoke('gmail.send', { accountId: A, operation: 'reply', messageId: 'm1', body: 'Following up.' }); assert.equal(r.status, 'pending'); if (r.status !== 'pending') throw new Error();
  await f.executor.decide(r.confirmationId, true);
  const parsed = await simpleParser(decodeData((f.api.mutations()[0]!.body as { raw: string }).raw, 12 * 1024 * 1024));
  assert.equal(parsed.from!.value[0]!.address, ownerA.email); assert.equal((Array.isArray(parsed.to) ? parsed.to[0] : parsed.to)!.value[0]!.address, 'recipient@example.test'); assert.equal(parsed.inReplyTo, '<source@example.test>');
});

for (const phrase of [...naturalApprovals, 'Sí', 'sí, confirma', 'confirmar', 'adelante', 'hazlo', 'sí, hazlo', 'sí, sí, te confirmo', 'Sí, sí, te confirmo. Envíaselo, por favor.', 'Sí, envíaselo', 'Sí, envíalo', 'sí, te confirmo, envíaselo por favor', 'confirmo', 'señor confirmo', 'No, cambiale el asunto.', 'Sí, pero mandalo a Pedro.', 'Agregá a Juan en copia.', 'Usá mi otra cuenta.', 'Adjuntá también el PDF.', 'No, mandalo a otra dirección', 'Sí, pero cambiá el asunto', 'Esperá, agregá a Juan en copia', 'Mandalo desde la otra cuenta', 'No lo envíes', 'Sí, envíalo a otra dirección', 'Sí, agregá un adjunto', 'Qué tengo mañana']) {
  test(`live Gmail confirmation lifecycle: ${phrase}`, async () => {
    const original = globalThis.fetch; const f = fixture(); const decisions: boolean[] = []; const notices: string[] = [];
    const affirmative = !['No, cambiale el asunto.', 'Sí, pero mandalo a Pedro.', 'Agregá a Juan en copia.', 'Usá mi otra cuenta.', 'Adjuntá también el PDF.', 'No, mandalo a otra dirección', 'Sí, pero cambiá el asunto', 'Esperá, agregá a Juan en copia', 'Mandalo desde la otra cuenta', 'No lo envíes', 'Sí, envíalo a otra dirección', 'Sí, agregá un adjunto', 'Qué tengo mañana'].includes(phrase);
    let invokes = 0; let cancellations = 0;
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    globalThis.fetch = async (url, options) => {
      const route = String(url).split('/').pop(); const input = options?.body ? JSON.parse(String(options.body)) : {};
      if (route === 'session') return Response.json({ tools: f.registry.descriptors(), timezone: 'Europe/Madrid', now: new Date().toISOString() });
      if (route === 'invoke') { invokes++; return Response.json(await f.executor.invoke(input.invocationId, input.toolId, input.input)); }
      if (route === 'activity') return Response.json({ activity: f.executor.telemetry.snapshot(), pending: f.executor.pendingState() });
      if (route === 'cancel') { cancellations++; f.executor.invalidate(); return Response.json({ cancelled: true }); }
      if (route === 'intent') return Response.json({ confirmationId: input.confirmationId, intent: fakeIntent(input.utterance) });
    if (route === 'decision') { decisions.push(input.approved); if (input.approved) await gate; return Response.json(await f.executor.decide(input.confirmationId, input.approved)); }
      throw new Error('Unexpected route');
    };
    const bridge = new VoiceToolBridge(() => {}, message => notices.push(message));
    try {
      const config = await bridge.initialize(); const sdkTool = config.tools.find(t => t.name === 'gmail_send')!;
      const invoke = () => sdkTool.invoke(new RunContext(), JSON.stringify({ inputJson: JSON.stringify(outgoing) }));
      await invoke(); const frozen = bridge.pending!.confirmationId;
      await bridge.transportEvent({ type: 'response.created', response: { id: 'prompt' } });
      // Real WebRTC ordering: stopped can arrive without a started event.
      await bridge.transportEvent({ type: 'output_audio_buffer.stopped', response_id: 'prompt' });
      await bridge.transportEvent({ type: 'input_audio_buffer.speech_started', item_id: 'confirmation' });
      await bridge.transportEvent({ type: 'response.created', response: { id: 'acknowledgment' } });
      await invoke(); assert.equal(invokes, 1); assert.equal(bridge.pending!.confirmationId, frozen);
      const completion = bridge.transportEvent({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'confirmation', transcript: phrase });
      if (affirmative) {
        await new Promise<void>(resolve => setImmediate(resolve));
        assert.deepEqual(decisions, [true]); assert.equal(cancellations, 0);
        assert.equal(notices.length, 0); assert.equal(f.api.mutations().length, 0);
        const awaiting = await invoke(); assert.ok(JSON.stringify(awaiting).includes('awaiting_execution')); assert.equal(invokes, 1);
        release(); await completion;
        assert.equal(f.api.mutations().length, 1); assert.equal(f.api.mutations()[0]!.accountId, A);
        assert.equal(notices.length, 1); assert.ok(notices[0]!.includes('"status":"success"')); assert.ok(notices[0]!.includes('"sent":true'));
        assert.ok(!notices.some(n => n.includes('cambió de solicitud')));
        await bridge.transcript('confirmation', phrase); assert.equal(f.api.mutations().length, 1);
      } else { await completion; assert.equal(f.api.mutations().length, 0); assert.ok(!decisions.includes(true)); assert.equal(bridge.pending, null); }
    } finally { release(); bridge.close(); f.executor.close(); globalThis.fetch = original; }
  });
}

for (const mode of ['early', 'stale', 'expired', 'failed']) {
  test(`natural Gmail confirmation remains fail-safe: ${mode}`, async () => {
    const original = globalThis.fetch; const f = fixture(); const notices: string[] = [];
    globalThis.fetch = async (url, options) => {
      const route = String(url).split('/').pop(); const input = options?.body ? JSON.parse(String(options.body)) : {};
      if (route === 'session') return Response.json({ tools: f.registry.descriptors(), timezone: 'Europe/Madrid', now: new Date().toISOString() });
      if (route === 'invoke') return Response.json(await f.executor.invoke(input.invocationId, input.toolId, input.input));
      if (route === 'activity') return Response.json({ activity: f.executor.telemetry.snapshot(), pending: f.executor.pendingState() });
      if (route === 'intent') return Response.json({ confirmationId: input.confirmationId, intent: fakeIntent(input.utterance) });
    if (route === 'decision') return Response.json(await f.executor.decide(input.confirmationId, input.approved));
      throw new Error('Unexpected route');
    };
    const bridge = new VoiceToolBridge(() => {}, n => notices.push(n));
    try {
      const config = await bridge.initialize(); const sdkTool = config.tools.find(t => t.name === 'gmail_send')!;
      await sdkTool.invoke(new RunContext(), JSON.stringify({ inputJson: JSON.stringify(outgoing) }));
      bridge.playbackStarted('prompt');
      if (mode === 'early') bridge.speechStarted('speech');
      bridge.playbackFinished('prompt');
      if (mode !== 'early' && mode !== 'stale') bridge.speechStarted('speech');
      if (mode === 'expired') f.expire();
      if (mode === 'failed') f.api.sendFailure = true;
      await bridge.transcript('speech', 'Sí, sí, te confirmo. Envíaselo, por favor.');
      assert.ok(!notices.some(n => n.includes('"status":"success"')));
      if (mode === 'failed') {
        assert.equal(f.api.mutations().length, 1); assert.equal(notices.length, 1); assert.ok(notices[0]!.includes('"status":"error"'));
        await bridge.transcript('speech', 'confirmo'); assert.equal(f.api.mutations().length, 1);
      } else assert.equal(f.api.mutations().length, 0);
    } finally { bridge.close(); f.executor.close(); globalThis.fetch = original; }
  });
}

test('persistent Sofia identity is available in another session but never bypasses Gmail sender/recipient/SENSITIVE safety', async () => {
  const { PrivateJsonMemoryStore } = await import('../memory/store.js'); const { MemoryService } = await import('../memory/service.js');
  const { candidate, source } = await import('../memory/test-fixtures.js'); const { randomUUID } = await import('node:crypto'); const { rm } = await import('node:fs/promises');
  const path = `.local/memory-tests/${randomUUID()}/memories.json`;
  try {
    const first = new MemoryService(new PrivateJsonMemoryStore(path));
    await first.remember(candidate('My partner is Sofia.', { type: 'USER_PROFILE', subject: { id: 'user', name: 'User', aliases: [] }, key: 'partner', relationships: [{ predicate: 'partner', target: { id: 'sofia', name: 'Sofia', aliases: [] } }] }), source('My partner is Sofia.'));
    const second = new MemoryService(new PrivateJsonMemoryStore(path)); const identityOnly = await second.search('Email Sofia'); assert.ok(identityOnly.length); assert.ok(identityOnly.every(r => r.value.email === undefined));
    await second.remember(candidate('Sofia email is sofia@example.test.', { type: 'PERSON', subject: { id: 'sofia', name: 'Sofia', aliases: [] }, key: 'email', value: { email: 'sofia@example.test' } }), source('Sofia email is sofia@example.test.'));
    const third = new MemoryService(new PrivateJsonMemoryStore(path)); const person = (await third.search('Email Sofia')).find(r => r.type === 'PERSON')!;
    const f = fixture();
    try {
      assert.equal((await f.invoke('gmail.send', { ...outgoing, accountId: undefined, from: undefined, to: [person.value.email] })).status, 'error');
      const prepared = await f.invoke('gmail.send', { ...outgoing, to: [person.value.email] }); assert.equal(prepared.status, 'pending'); assert.equal(f.api.mutations().length, 0); if (prepared.status !== 'pending') throw new Error();
      assert.equal((await f.executor.decide(prepared.confirmationId, true)).status, 'success'); assert.equal(f.api.mutations().length, 1);
    } finally { f.executor.close(); }
  } finally { await rm(path.slice(0, path.lastIndexOf('/')), { recursive: true, force: true }); }
});
