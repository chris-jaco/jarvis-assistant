import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { ToolError } from '../types.js';
import type { ToolAdapter, ToolDefinition, Permission } from '../types.js';
import { range, validateTimezone } from './time.js';
export interface CalendarTransport { ready?(signal: AbortSignal): Promise<void>; request(method: string, path: string, body: unknown, signal: AbortSignal, etag?: string): Promise<unknown> }
export class GoogleCalendarTransport implements CalendarTransport {
  constructor(private readonly accessToken: () => Promise<string>, private readonly requestFetch: typeof fetch = fetch) {}
  async ready(signal: AbortSignal): Promise<void> { await this.accessToken(); signal.throwIfAborted(); }
  async request(method: string, path: string, body: unknown, signal: AbortSignal, etag?: string): Promise<unknown> {
    const token = await this.accessToken(); signal.throwIfAborted();
    const response = await this.requestFetch(`https://www.googleapis.com/calendar/v3/${path}`, { method, signal,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(etag ? { 'If-Match': etag } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (response.status === 412) throw new ToolError('CONFLICT');
    if (!response.ok) throw new ToolError('UPSTREAM');
    return response.status === 204 ? { deleted: true } : response.json();
  }
}
interface EventTime { dateTime?: string; date?: string; timeZone?: string }
interface CalendarAttendee { email: string; displayName?: string; responseStatus?: string; optional?: boolean; additionalGuests?: number; comment?: string }
interface CalendarEvent { id: string; attendees?: CalendarAttendee[]; attendeesOmitted?: boolean; summary?: string; start?: EventTime; end?: EventTime; etag?: string; status?: string; recurringEventId?: string; recurrence?: string[]; description?: string }
const dateRange = { start: z.string().min(10).max(40), end: z.string().min(10).max(40) };
const targetSchema = z.object({ eventId: z.string().max(1024).optional(), query: z.string().min(1).max(200).optional(), start: z.string().max(40).optional(), end: z.string().max(40).optional() }).strict();
type Target = z.infer<typeof targetSchema>;
const emails = z.array(z.string().trim().toLowerCase().email().max(254)).max(50);
const createSchema = z.object({ title: z.string().min(1).max(200), ...dateRange, attendees: emails.optional() }).strict();
const updateSchema = z.object({ target: targetSchema, title: z.string().min(1).max(200).optional(), start: dateRange.start.optional(), end: dateRange.end.optional(), attendees: emails.optional(), attendeeMode: z.enum(['add', 'replace', 'remove']).optional() }).strict();
function uniqueEmails(input: string[]): string[] { return [...new Set(input)]; }
function attendeeSummary(attendees: CalendarAttendee[]): string { return ` Asistentes finales: ${attendees.length ? attendees.map(a => a.email).join(', ') : 'ninguno'}. Se enviarán actualizaciones de invitación.`; }
interface Prepared { sendUpdates?: 'all' | 'none'; event?: CalendarEvent; body?: Record<string, unknown>; etag?: string; summary: string }
export class CalendarAdapter implements ToolAdapter {
  readonly integration = 'google-calendar'; readonly transport = 'api' as const;
  readonly timezone: string;
  private readonly base: string;
  constructor(private readonly api: CalendarTransport, timezone: string, calendarId = 'primary', private readonly confirmWrites = true) {
    this.timezone = validateTimezone(timezone); this.base = `calendars/${encodeURIComponent(calendarId)}`;
  }
  private view(event: CalendarEvent) { return { id: event.id, title: event.summary ?? '(sin título)', start: event.start, end: event.end, timezone: this.timezone, recurring: Boolean(event.recurringEventId) }; }
  private async list(start: string, end: string, signal: AbortSignal, query?: string): Promise<CalendarEvent[]> {
    const bounds = range(start, end, this.timezone);
    const params = new URLSearchParams({ ...bounds, timeZone: this.timezone, singleEvents: 'true', orderBy: 'startTime', maxResults: '100', ...(query ? { q: query } : {}) });
    const data = await this.api.request('GET', `${this.base}/events?${params}`, undefined, signal) as { items?: CalendarEvent[]; nextPageToken?: string };
    // Never claim completeness or mutate from a truncated result set.
    if (data.nextPageToken) throw new ToolError('LIMIT');
    return (data.items ?? []).filter(event => event.status !== 'cancelled');
  }
  private async resolve(target: Target, signal: AbortSignal): Promise<CalendarEvent> {
    if (target.eventId) {
      if (target.query || target.start || target.end) throw new ToolError('INVALID_INPUT');
      const event = await this.api.request('GET', `${this.base}/events/${encodeURIComponent(target.eventId)}`, undefined, signal) as CalendarEvent;
      if (!event.id || event.status === 'cancelled') throw new ToolError('CONFLICT');
      return event;
    }
    if (!target.query || !target.start || !target.end) throw new ToolError('INVALID_INPUT');
    const events = await this.list(target.start, target.end, signal, target.query);
    if (events.length > 1) throw new ToolError('AMBIGUOUS');
    if (!events[0]) throw new ToolError('CONFLICT');
    // Fetch fresh etag/details; list payload is never trusted for mutation.
    return this.resolve({ eventId: events[0].id }, signal);
  }
  tools(): ToolDefinition[] {
    const definition = (id: string, description: string, permission: Permission, schema: z.ZodType, execute: ToolDefinition['execute'], prepare?: ToolDefinition['prepare']): ToolDefinition => ({
      id, name: id, description, integration: this.integration, capability: id.split('.')[1]!, permission, confirm: this.confirmWrites, schema, execute, prepare,
      confirmWhen: raw => (raw as Prepared | undefined)?.sendUpdates === 'all',
      summarize: raw => (raw as Prepared).summary });
    return [
      definition('calendar.listEvents', 'Lista eventos de un rango explícito. Para próximos eventos usa ahora y una fecha fin cercana. Fechas locales se interpretan en USER_TIMEZONE.', 'READ', z.object(dateRange).strict(), async (raw, signal) => {
        const p = raw as { start: string; end: string }; return { events: (await this.list(p.start, p.end, signal)).map(e => this.view(e)), timezone: this.timezone };
      }),
      definition('calendar.getEvent', 'Consulta un evento por ID o búsqueda con rango. Ante ambigüedad pide elegir; nunca adivines.', 'READ', z.object({ target: targetSchema }).strict(), async (raw, signal) => {
        const event = await this.resolve((raw as { target: Target }).target, signal); return { ...this.view(event), attendees: event.attendees?.map(a => ({ email: a.email })), description: event.description?.slice(0, 1000) };
      }),
      definition('calendar.availability', 'Comprueba huecos libres dentro del rango, no solo títulos de eventos.', 'READ', z.object(dateRange).strict(), async (raw, signal) => {
        const p = raw as { start: string; end: string }; const bounds = range(p.start, p.end, this.timezone);
        const result = await this.api.request('POST', 'freeBusy', { ...bounds, timeZone: this.timezone, items: [{ id: decodeURIComponent(this.base.slice(10)) }] }, signal) as { calendars?: Record<string, { busy?: Array<{ start: string; end: string }>; errors?: unknown[] }> };
        const calendar = result.calendars?.[decodeURIComponent(this.base.slice(10))];
        if (!calendar || calendar.errors?.length || !calendar.busy) throw new ToolError('UPSTREAM');
        const lo = Date.parse(bounds.timeMin), hi = Date.parse(bounds.timeMax);
        const busy = calendar.busy.map(b => ({ start: Math.max(lo, Date.parse(b.start)), end: Math.min(hi, Date.parse(b.end)) })).sort((a, b) => a.start - b.start);
        if (busy.some(b => !Number.isFinite(b.start) || !Number.isFinite(b.end))) throw new ToolError('UPSTREAM');
        let cursor = lo; const free: Array<{ start: string; end: string }> = [];
        for (const interval of busy) { if (interval.start > cursor) free.push({ start: new Date(cursor).toISOString(), end: new Date(interval.start).toISOString() }); cursor = Math.max(cursor, interval.end); }
        if (cursor < hi) free.push({ start: new Date(cursor).toISOString(), end: new Date(hi).toISOString() });
        return { free, timezone: this.timezone };
      }),
      definition('calendar.createEvent', 'Crea un evento con título y comienzo/fin explícitos. Asistentes opcionales son emails explícitos, nunca nombres adivinados. Las invitaciones requieren confirmación.', 'WRITE', createSchema,
        async (raw, signal) => { const p = raw as Prepared; return this.view(await this.api.request('POST', `${this.base}/events?sendUpdates=${p.sendUpdates}`, p.body, signal) as CalendarEvent); },
        async (raw, signal) => {
          await this.api.ready?.(signal); const p = raw as z.infer<typeof createSchema>; const b = range(p.start, p.end, this.timezone);
          const attendees = uniqueEmails(p.attendees ?? []).map(email => ({ email }));
          return { sendUpdates: attendees.length ? 'all' : 'none', body: { id: randomUUID().replaceAll('-', ''), summary: p.title, start: { dateTime: b.timeMin, timeZone: this.timezone }, end: { dateTime: b.timeMax, timeZone: this.timezone }, ...(attendees.length ? { attendees } : {}) },
            summary: `¿Confirmas crear «${p.title}» de ${p.start} a ${p.end} (${this.timezone})?${attendees.length ? attendeeSummary(attendees) : ''}` } satisfies Prepared;
        }),
      definition('calendar.updateEvent', 'Actualiza un evento único: título, horario completo o asistentes. Emails explícitos obligatorios. attendeeMode add conserva asistentes; replace/remove solo por petición explícita. No edita series completas.', 'WRITE', updateSchema,
        async (raw, signal) => { const p = raw as Prepared; return this.view(await this.api.request('PATCH', `${this.base}/events/${encodeURIComponent(p.event!.id)}?sendUpdates=${p.sendUpdates}`, p.body, signal, p.etag) as CalendarEvent); },
        async (raw, signal) => {
          const p = raw as z.infer<typeof updateSchema>;
          if ((p.start === undefined) !== (p.end === undefined) || (p.attendeeMode && !p.attendees) || (p.title === undefined && p.start === undefined && p.attendees === undefined)) throw new ToolError('INVALID_INPUT');
          const event = structuredClone(await this.resolve(p.target, signal));
          if (event.recurrence?.length || !event.etag || !event.start?.dateTime || event.attendeesOmitted) throw new ToolError('CONFLICT');
          const body: Record<string, unknown> = { ...(p.title !== undefined ? { summary: p.title } : {}) };
          const changes: string[] = [];
          if (p.title !== undefined) changes.push(`título «${p.title}»`);
          if (p.start && p.end) {
            const b = range(p.start, p.end, this.timezone);
            body.start = { dateTime: b.timeMin, timeZone: this.timezone }; body.end = { dateTime: b.timeMax, timeZone: this.timezone };
            changes.push(`horario ${p.start}–${p.end}`);
          }
          const existing = (event.attendees ?? []).map(a => ({ email: a.email.trim().toLowerCase(),
            ...(a.displayName !== undefined ? { displayName: a.displayName } : {}),
            ...(a.responseStatus !== undefined ? { responseStatus: a.responseStatus } : {}),
            ...(a.optional !== undefined ? { optional: a.optional } : {}),
            ...(a.additionalGuests !== undefined ? { additionalGuests: a.additionalGuests } : {}),
            ...(a.comment !== undefined ? { comment: a.comment } : {}) }));
          let attendees = existing;
          if (p.attendees !== undefined) {
            const requested = uniqueEmails(p.attendees); const mode = p.attendeeMode ?? 'add';
            const retained = mode === 'replace' ? existing.filter(a => requested.includes(a.email)) : mode === 'remove' ? existing.filter(a => !requested.includes(a.email)) : existing;
            const merged = new Map(retained.map(a => [a.email, a]));
            if (mode !== 'remove') for (const email of requested) if (!merged.has(email)) merged.set(email, { email });
            attendees = [...merged.values()]; body.attendees = attendees;
            changes.push(`asistentes ${mode}: ${requested.join(', ') || 'ninguno'}`);
          }
          const sendUpdates = existing.length || attendees.length ? 'all' : 'none';
          return { event, etag: event.etag, body, sendUpdates, summary: `¿Confirmas actualizar «${event.summary ?? '(sin título)'}» (${event.start.dateTime}, ${this.timezone}): ${changes.join('; ')}? Solo esta ocurrencia.${sendUpdates === 'all' ? attendeeSummary(attendees) : ''}` } satisfies Prepared;
        }),
      definition('calendar.deleteEvent', 'Elimina un único evento/ocurrencia. Siempre requiere confirmación explícita. Nunca borra una serie completa.', 'SENSITIVE', z.object({ target: targetSchema }).strict(),
        async (raw, signal) => { const p = raw as Prepared; await this.api.request('DELETE', `${this.base}/events/${encodeURIComponent(p.event!.id)}?sendUpdates=none`, undefined, signal, p.etag); return { deleted: true }; },
        async (raw, signal) => { const event = await this.resolve((raw as { target: Target }).target, signal); if (event.recurrence?.length || !event.etag || (!event.start?.dateTime && !event.start?.date)) throw new ToolError('CONFLICT');
          return { event, etag: event.etag, summary: `¿Confirmas eliminar «${event.summary ?? '(sin título)'}» (${event.start.dateTime ?? event.start.date}, ${this.timezone})? Solo este evento/ocurrencia.` } satisfies Prepared; })
    ];
  }
}
