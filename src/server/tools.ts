import type { IncomingMessage, ServerResponse } from 'node:http';
import { confirmationTracer } from '../diagnostics/confirmation.js';
import type { TraceSink } from '../diagnostics/confirmation.js';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { ToolRegistry } from '../tools/registry.js';
import { ToolExecutor } from '../tools/execution.js';
import { WebSearchAdapter } from '../tools/adapters/search.js';
import { CalendarAdapter, GoogleCalendarTransport } from '../tools/adapters/calendar.js';
import { GoogleAuth, googleConfig } from '../tools/adapters/google-auth.js';
import { GmailAccountStore } from '../tools/adapters/gmail-accounts.js';
import { GmailAdapter } from '../tools/adapters/gmail.js';
import { GoogleGmailTransport } from '../tools/adapters/gmail-transport.js';
import { validateTimezone } from '../tools/adapters/time.js';
export function createToolRuntime(env: NodeJS.ProcessEnv = process.env) {
  const timezone = validateTimezone(env.USER_TIMEZONE ?? 'Europe/Madrid');
  const writePolicy = env.TOOL_CONFIRM_WRITES ?? 'true';
  if (!['true', 'false'].includes(writePolicy)) throw new Error('TOOL_CONFIRM_WRITES must be true or false');
  const registry = new ToolRegistry();
  registry.add(new WebSearchAdapter(env.OPENAI_API_KEY, env.OPENAI_SEARCH_MODEL ?? 'gpt-4.1'));
  const auth = new GoogleAuth(googleConfig(env));
  registry.add(new CalendarAdapter(new GoogleCalendarTransport(() => auth.token()), timezone, env.GOOGLE_CALENDAR_ID ?? 'primary', writePolicy === 'true'));
  const gmail = new GmailAccountStore(env);
  registry.add(new GmailAdapter(gmail, new GoogleGmailTransport(gmail), timezone, writePolicy === 'true'));
  return { registry, timezone };
}
const invocation = z.object({ invocationId: z.string().min(1).max(128), toolId: z.string().max(80), input: z.unknown() }).strict();
const decision = z.object({ confirmationId: z.string().uuid(), approved: z.boolean() }).strict();
async function body(req: IncomingMessage): Promise<unknown> {
  if (req.headers['content-type']?.split(';')[0] !== 'application/json') throw new Error();
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const chunk of req) { bytes += chunk.length; if (bytes > 16_384) throw new Error(); chunks.push(Buffer.from(chunk)); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
export function createToolsHandler(env: NodeJS.ProcessEnv = process.env, diagnostics: { development?: boolean; sink?: TraceSink } = {}) {
  const confirmationTrace = diagnostics.development === true && env.JARVIS_CONFIRMATION_TRACE === 'true';
  const trace = confirmationTracer(confirmationTrace, diagnostics.sink);
  const { registry, timezone } = createToolRuntime(env);
  const sessions = new Map<string, { executor: ToolExecutor; expiresAt: number; busy: boolean }>();
  const lifetime = 30 * 60_000;
  const cleanup = () => { for (const [id, session] of sessions) if (session.expiresAt <= Date.now()) { session.executor.close(); sessions.delete(id); } };
  const timer = setInterval(cleanup, 60_000); timer.unref();
  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const path = req.url?.split('?')[0];
    if (!path?.startsWith('/api/tools/')) return false;
    res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
    const send = (status: number, data: unknown) => { res.writeHead(status); res.end(JSON.stringify(data)); };
    const origin = req.headers.origin;
    if ((origin && origin !== `http://${req.headers.host}` && origin !== `https://${req.headers.host}`) || req.headers['sec-fetch-site'] === 'cross-site') { send(403, { error: 'Origen no permitido.' }); return true; }
    cleanup();
    if (path === '/api/tools/session' && req.method === 'POST') {
      if (req.headers['content-type']?.split(';')[0] !== 'application/json') { send(415, { error: 'JSON requerido.' }); return true; }
      const previousId = /(?:^|;\s*)jarvis_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie ?? '')?.[1];
      if (previousId) { sessions.get(previousId)?.executor.close(); sessions.delete(previousId); }
      if (sessions.size >= 10) { send(429, { error: 'Demasiadas sesiones.' }); return true; }
      const id = randomBytes(32).toString('hex');
      sessions.set(id, { executor: new ToolExecutor(registry, Date.now, 60_000, undefined, trace), expiresAt: Date.now() + lifetime, busy: false });
      res.setHeader('Set-Cookie', `jarvis_session=${id}; HttpOnly; SameSite=Strict; Path=/api/tools; Max-Age=1800${origin?.startsWith('https:') ? '; Secure' : ''}`);
      send(200, { tools: registry.descriptors(), timezone, now: new Date().toISOString(), confirmationTrace }); return true;
    }
    const id = /(?:^|;\s*)jarvis_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie ?? '')?.[1];
    const session = id ? sessions.get(id) : undefined;
    if (!session) { send(401, { error: 'Sesión de herramientas caducada. Reconecta.' }); return true; }
    if (path === '/api/tools/session' && req.method === 'DELETE') { session.executor.close(); sessions.delete(id!); send(200, { closed: true }); return true; }
    if (path === '/api/tools/activity' && req.method === 'GET') { send(200, { activity: session.executor.telemetry.snapshot(), pending: session.executor.pendingState() }); return true; }
    if (req.method !== 'POST') { send(405, { error: 'Método no permitido.' }); return true; }
    if (session.busy) { send(429, { error: 'Una herramienta sigue ejecutándose.' }); return true; }
    session.busy = true;
    try {
      const input = await body(req);
      if (path === '/api/tools/invoke') {
        const p = invocation.parse(input); trace({ event: 'server POST /invoke', reason: 'request' }); send(200, await session.executor.invoke(p.invocationId, p.toolId, p.input));
      } else if (path === '/api/tools/decision') {
        const p = decision.parse(input); trace({ event: 'server POST /decision', reason: p.approved ? 'approved' : 'rejected', pendingId: p.confirmationId }); send(200, await session.executor.decide(p.confirmationId, p.approved));
      } else if (path === '/api/tools/cancel') { trace({ event: 'server POST /cancel', reason: 'request' }); session.executor.invalidate(); send(200, { cancelled: true }); }
      else send(404, { error: 'Ruta desconocida.' });
    } catch { send(400, { error: 'Solicitud inválida.' }); }
    finally { session.busy = false; }
    return true;
  };
  return { handle, close: () => { clearInterval(timer); for (const session of sessions.values()) session.executor.close(); sessions.clear(); } };
}
