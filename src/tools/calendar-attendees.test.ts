import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CalendarAdapter } from './adapters/calendar.js';
import { ToolRegistry } from './registry.js';
import { ToolExecutor } from './execution.js';
import type { ToolResult } from './types.js';
const base = { title: 'Prueba', start: '2026-10-04T18:00:00', end: '2026-10-04T18:30:00' };
function fixture(confirmWrites = true) {
  const event = { id: 'one', summary: 'Prueba', etag: 'version1', start: { dateTime: base.start }, end: { dateTime: base.end }, attendees: [{ email: 'existing@example.com', responseStatus: 'accepted', organizer: true, self: true }] };
  const mutations: Array<{ method: string; path: string; body: Record<string, unknown>; etag?: string }> = [];
  const registry = new ToolRegistry(); registry.add(new CalendarAdapter({ request: async (method, path, body, _signal, etag) => {
    if (method === 'GET') return structuredClone(event);
    mutations.push({ method, path, body: structuredClone(body) as Record<string, unknown>, etag }); return event;
  } }, 'Europe/Madrid', 'primary', confirmWrites));
  return { executor: new ToolExecutor(registry), mutations, event };
}
async function approve(f: ReturnType<typeof fixture>, r: ToolResult) { assert.equal(r.status, 'pending'); if (r.status !== 'pending') throw new Error(); assert.equal(f.mutations.length, 0); return f.executor.decide(r.confirmationId, true); }
for (const attendees of [['sofia@example.com'], ['sofia@example.com', 'juan@example.com']]) {
  test(`create with ${attendees.length} attendees freezes recipients and sends invitations only after explicit approval`, async () => {
    const f = fixture(false); const r = await f.executor.invoke('create', 'calendar.createEvent', { ...base, attendees });
    assert.equal(r.status, 'pending'); if (r.status === 'pending') for (const email of attendees) assert.ok(r.summary.includes(email));
    attendees.push('late@example.com');
    await approve(f, r); assert.equal(f.mutations.length, 1); assert.ok(f.mutations[0]!.path.endsWith('sendUpdates=all'));
    assert.ok(!(f.mutations[0]!.body.attendees as Array<{ email: string }>).some(a => a.email === 'late@example.com'));
  });
}
test('attendee emails normalized/deduplicated; invalid names/emails fail before any mutation', async () => {
  const f = fixture(); const r = await f.executor.invoke('good', 'calendar.createEvent', { ...base, attendees: [' SOFIA@Example.com ', 'sofia@example.com'] }); await approve(f, r);
  assert.deepEqual(f.mutations[0]!.body.attendees, [{ email: 'sofia@example.com' }]);
  for (const email of ['Sofía', 'bad email', 'x@example.com\nBcc:y@example.com']) {
    const invalid = fixture(); const result = await invalid.executor.invoke('bad', 'calendar.createEvent', { ...base, attendees: [email] });
    assert.equal(result.status, 'error'); assert.equal(invalid.mutations.length, 0); assert.equal(invalid.executor.pendingState(), null);
  }
});
test('attendee-only update adds without dropping existing participants or their RSVP; frozen etag/body', async () => {
  const f = fixture(false); const r = await f.executor.invoke('update', 'calendar.updateEvent', { target: { eventId: 'one' }, attendees: ['sofia@example.com'] });
  f.event.attendees.push({ email: 'late@example.com', responseStatus: 'accepted', organizer: false, self: false }); f.event.etag = 'changed';
  await approve(f, r); const m = f.mutations[0]!;
  assert.deepEqual(m.body.attendees, [{ email: 'existing@example.com', responseStatus: 'accepted' }, { email: 'sofia@example.com' }]);
  assert.equal(m.etag, 'version1'); assert.equal(m.body.start, undefined); assert.ok(m.path.endsWith('sendUpdates=all'));
});
test('replace/remove require explicit modes and display recipients/removals before executing', async () => {
  for (const mode of ['replace', 'remove'] as const) {
    const f = fixture(false); const attendees = mode === 'replace' ? ['sofia@example.com'] : ['existing@example.com'];
    const r = await f.executor.invoke('update', 'calendar.updateEvent', { target: { eventId: 'one' }, attendees, attendeeMode: mode });
    if (r.status !== 'pending') throw new Error(); assert.ok(r.summary.includes(mode)); assert.ok(r.summary.includes(attendees[0]!));
    await approve(f, r); assert.deepEqual(f.mutations[0]!.body.attendees, mode === 'replace' ? [{ email: 'sofia@example.com' }] : []);
  }
});
test('rejected/cancelled attendee mutations never send invitations or patch/create events', async () => {
  for (const action of ['calendar.createEvent', 'calendar.updateEvent']) for (const cancel of [true, false]) {
    const f = fixture(false); const r = await f.executor.invoke('write', action, action.endsWith('createEvent') ? { ...base, attendees: ['sofia@example.com'] } : { target: { eventId: 'one' }, attendees: ['sofia@example.com'] });
    if (r.status !== 'pending') throw new Error();
    if (cancel) f.executor.invalidate(); else await f.executor.decide(r.confirmationId, false);
    await f.executor.decide(r.confirmationId, true); assert.equal(f.mutations.length, 0);
  }
});
test('moving an invited event preserves attendees and requires approval for outgoing updates', async () => {
  const f = fixture(false); const r = await f.executor.invoke('move', 'calendar.updateEvent', { target: { eventId: 'one' }, start: '2026-10-04T18:30:00', end: '2026-10-04T19:00:00' });
  await approve(f, r); assert.equal(f.mutations[0]!.body.attendees, undefined); assert.ok(f.mutations[0]!.path.endsWith('sendUpdates=all'));
});
test('non-invitation creates preserve WRITE opt-out; partial/no-op update rejected', async () => {
  const f = fixture(false); assert.equal((await f.executor.invoke('create', 'calendar.createEvent', base)).status, 'success'); assert.ok(f.mutations[0]!.path.endsWith('sendUpdates=none'));
  for (const input of [{ target: { eventId: 'one' } }, { target: { eventId: 'one' }, start: base.start }, { target: { eventId: 'one' }, attendeeMode: 'replace' }]) {
    const invalid = fixture(); assert.equal((await invalid.executor.invoke('bad', 'calendar.updateEvent', input)).status, 'error'); assert.equal(invalid.mutations.length, 0);
  }
});
