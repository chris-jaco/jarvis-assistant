import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CalendarAdapter, GoogleCalendarTransport } from './adapters/calendar.js';
import type { CalendarTransport } from './adapters/calendar.js';
import { WebSearchAdapter } from './adapters/search.js';
import { instant, range, validateTimezone } from './adapters/time.js';
import { ToolRegistry } from './registry.js';
import { ToolExecutor } from './execution.js';
import { ToolError } from './types.js';
import { createToolRuntime } from '../server/tools.js';
import { mcpAdapter } from './adapters/mcp.js';
import type { MCPServer } from '@openai/agents-core';
const signal = () => new AbortController().signal;
const event = { id: 'one', summary: 'Prueba', start: { dateTime: '2026-10-04T18:00:00+02:00' }, end: { dateTime: '2026-10-04T18:30:00+02:00' }, etag: 'version1' };
const bounds = { start: '2026-10-04T00:00:00', end: '2026-10-05T00:00:00' };
function calendar(request: CalendarTransport['request'], confirm = true) { const adapter = new CalendarAdapter({ request }, 'Europe/Madrid', 'primary', confirm); const registry = new ToolRegistry(); registry.add(adapter); return { adapter, executor: new ToolExecutor(registry) }; }
test('web search sends current hosted web_search on backend and returns concise answer/citations', async () => {
  const adapter = new WebSearchAdapter('secret', 'model', async (url, options) => {
    assert.equal(url, 'https://api.openai.com/v1/responses'); const body = JSON.parse(String(options?.body));
    assert.equal(body.tools[0].type, 'web_search'); assert.equal(body.store, false); assert.equal(body.max_tool_calls, 2);
    return Response.json({ status: 'completed', output: [{ type: 'web_search_call', status: 'completed' }, { type: 'message', content: [{ type: 'output_text', text: 'Noticias actuales', annotations: [{ type: 'url_citation', url: 'https://openai.com', title: 'OpenAI' }] }] }] });
  });
  const result = await adapter.tools()[0]!.execute({ query: 'Hoy' }, signal()) as { answer: string; sources: unknown[] }; assert.equal(result.answer, 'Noticias actuales'); assert.equal(result.sources.length, 1);
});
test('web failures/unconfigured/incomplete/non-search responses return safe errors, never stale invented data', async () => {
  const requests = [async () => Response.json({ secret: 'secret' }, { status: 401 }), async () => { throw new Error('secret'); }, async () => Response.json({ status: 'completed', output: [] }), async () => Response.json({ status: 'incomplete', output: [] })];
  for (const request of requests) { const registry = new ToolRegistry(); registry.add(new WebSearchAdapter('secret', 'model', request)); const r = await new ToolExecutor(registry).invoke('1', 'web.search', { query: 'Current' }); assert.equal(r.status, 'error'); assert.ok(!JSON.stringify(r).includes('secret')); }
  await assert.rejects(new WebSearchAdapter().tools()[0]!.execute({ query: 'hi' }, signal()), (e: unknown) => e instanceof ToolError && e.category === 'UNCONFIGURED');
});
test('local dates respect configured timezone and reject DST gaps/overlaps and invalid ranges', () => {
  assert.equal(instant('2026-10-04T18:00:00', 'Europe/Madrid'), '2026-10-04T16:00:00Z');
  assert.equal(instant('2026-12-04T18:00:00', 'Europe/Madrid'), '2026-12-04T17:00:00Z');
  assert.equal(instant('2026-10-04T18:00:00Z', 'Europe/Madrid'), '2026-10-04T18:00:00Z');
  for (const date of ['2026-03-29T02:30:00', '2026-10-25T02:30:00', 'garbage']) assert.throws(() => instant(date, 'Europe/Madrid'), ToolError);
  assert.throws(() => range(bounds.end, bounds.start, 'Europe/Madrid'), ToolError); assert.throws(() => validateTimezone('wrong'));
});
test('Calendar lists normalized events in explicit range/timezone and fails on truncated lists', async () => {
  const c = calendar(async (method, path) => { assert.equal(method, 'GET'); assert.ok(path.includes('timeZone=Europe%2FMadrid')); assert.ok(path.includes('singleEvents=true')); return { items: [event] }; });
  const r = await c.executor.invoke('1', 'calendar.listEvents', bounds); assert.equal(r.status, 'success'); if (r.status === 'success') assert.ok(JSON.stringify(r.data).includes('Prueba'));
  const truncated = calendar(async () => ({ items: [event], nextPageToken: 'more' })); assert.equal((await truncated.executor.invoke('1', 'calendar.listEvents', bounds)).status, 'error');
});
test('availability merges busy intervals and returns actual free time', async () => {
  const c = calendar(async (method, path, body) => { assert.equal(method, 'POST'); assert.equal(path, 'freeBusy'); assert.equal((body as { timeZone: string }).timeZone, 'Europe/Madrid');
    return { calendars: { primary: { busy: [{ start: '2026-10-04T08:00:00Z', end: '2026-10-04T09:00:00Z' }, { start: '2026-10-04T08:30:00Z', end: '2026-10-04T10:00:00Z' }] } } }; });
  const r = await c.executor.invoke('1', 'calendar.availability', { start: '2026-10-04T09:00:00', end: '2026-10-04T14:00:00' });
  assert.equal(r.status, 'success'); if (r.status === 'success') assert.deepEqual((r.data as { free: unknown[] }).free, [{ start: '2026-10-04T07:00:00.000Z', end: '2026-10-04T08:00:00.000Z' }, { start: '2026-10-04T10:00:00.000Z', end: '2026-10-04T12:00:00.000Z' }]);
});
test('ambiguous query never prepares confirmation or mutates; ask for event selection', async () => {
  const calls: string[] = []; const c = calendar(async (method) => { calls.push(method); return { items: [event, { ...event, id: 'two' }] }; });
  const r = await c.executor.invoke('1', 'calendar.deleteEvent', { target: { query: 'Pedro', ...bounds } });
  assert.equal(r.status, 'error'); if (r.status === 'error') assert.equal(r.category, 'AMBIGUOUS'); assert.deepEqual(calls, ['GET']); assert.equal(c.executor.pendingState(), null);
});
test('create/update are configurable writes; delete always confirmed and uses frozen ID/etag', async () => {
  const calls: Array<{ method: string; path: string; body: unknown; etag?: string }> = [];
  const c = calendar(async (method, path, body, _signal, etag) => { calls.push({ method, path, body, etag }); return method === 'DELETE' ? {} : event; }, false);
  assert.equal((await c.executor.invoke('create', 'calendar.createEvent', { title: 'Prueba', start: '2026-10-04T18:00:00', end: '2026-10-04T18:30:00' })).status, 'success');
  const created = calls[0]!.body as { id: string; start: { dateTime: string } }; assert.match(created.id, /^[a-f0-9]{32}$/); assert.equal(created.start.dateTime, '2026-10-04T16:00:00Z');
  assert.equal((await c.executor.invoke('update', 'calendar.updateEvent', { target: { eventId: 'one' }, start: '2026-10-04T18:30:00', end: '2026-10-04T19:00:00' })).status, 'success');
  assert.equal(calls.find(c => c.method === 'PATCH')?.etag, 'version1');
  const pending = await c.executor.invoke('delete', 'calendar.deleteEvent', { target: { eventId: 'one' } }); assert.equal(pending.status, 'pending'); assert.ok(!calls.some(c => c.method === 'DELETE'));
  if (pending.status !== 'pending') throw new Error(); assert.ok(pending.summary.includes('Prueba')); assert.ok(pending.summary.includes('18:00'));
  await c.executor.decide(pending.confirmationId, true); assert.equal(calls.filter(c => c.method === 'DELETE').length, 1); assert.equal(calls.at(-1)?.etag, 'version1');
});
test('mutation rejects recurring series and changed event version without retry', async () => {
  const series = calendar(async () => ({ ...event, recurrence: ['RRULE:FREQ=DAILY'] })); assert.equal((await series.executor.invoke('1', 'calendar.deleteEvent', { target: { eventId: 'master' } })).status, 'error');
  const c = calendar(async method => { if (method === 'DELETE') throw new ToolError('CONFLICT'); return event; });
  const r = await c.executor.invoke('1', 'calendar.deleteEvent', { target: { eventId: 'one' } }); if (r.status !== 'pending') throw new Error();
  const result = await c.executor.decide(r.confirmationId, true); assert.equal(result.status, 'error'); if (result.status === 'error') assert.equal(result.category, 'CONFLICT');
});
test('Calendar transport does not expose credentials or upstream bodies, and applies If-Match', async () => {
  const transport = new GoogleCalendarTransport(async () => 'secret', async (url, options) => { assert.ok(String(url).startsWith('https://www.googleapis.com/calendar/v3/')); assert.equal(new Headers(options?.headers).get('If-Match'), 'version'); return new Response('secret', { status: 412 }); });
  await assert.rejects(transport.request('DELETE', 'calendars/primary/events/id', undefined, signal(), 'version'), (e: unknown) => e instanceof ToolError && e.category === 'CONFLICT' && !e.message.includes('secret'));
});
test('unconfigured Calendar does not break runtime startup or registry availability', async () => {
  const { registry } = createToolRuntime({ USER_TIMEZONE: 'Europe/Madrid' }); assert.ok(registry.resolve('web.search')); assert.ok(registry.resolve('calendar.listEvents'));
  const r = await new ToolExecutor(registry).invoke('1', 'calendar.listEvents', bounds); assert.equal(r.status, 'error'); if (r.status === 'error') assert.equal(r.category, 'UNCONFIGURED');
  const create = await new ToolExecutor(registry).invoke('create', 'calendar.createEvent', { title: 'Test', start: '2026-10-04T18:00:00', end: '2026-10-04T18:30:00' }); assert.equal(create.status, 'error'); if (create.status === 'error') assert.equal(create.category, 'UNCONFIGURED');
  assert.throws(() => createToolRuntime({ TOOL_CONFIRM_WRITES: 'invalid' }));
});
test('MCP official server interface only registers reviewed tools and projects safe output', async () => {
  let closed = false; let receivedSignal = false;
  const server = { connect: async () => {}, listTools: async () => [{ name: 'read' }, { name: 'delete' }], callToolResult: async (_name: string, _args: unknown, _meta: unknown, options: { signal: AbortSignal }) => { receivedSignal = Boolean(options.signal); return { structuredContent: { ok: true }, credentials: 'secret' }; }, close: async () => { closed = true; } } as unknown as MCPServer;
  const adapter = await mcpAdapter(server, 'example', [{ id: 'example.read', remoteName: 'read', name: 'Read', description: 'Read', capability: 'read', permission: 'READ', schema: (await import('zod')).z.object({}), project: raw => (raw as { structuredContent: unknown }).structuredContent }]);
  assert.equal(adapter.tools().length, 1); assert.deepEqual(await adapter.tools()[0]!.execute({}, signal()), { ok: true }); assert.equal(receivedSignal, true); await adapter.close!(); assert.equal(closed, true);
});
