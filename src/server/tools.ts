import type { IncomingMessage, ServerResponse } from 'node:http';
import { confirmationTracer } from '../diagnostics/confirmation.js';
import type { TraceSink } from '../diagnostics/confirmation.js';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { ToolRegistry } from '../tools/registry.js';
import { createMemoryRuntime } from '../memory/runtime.js';
import type { MemoryRuntime } from '../memory/runtime.js';
import { MemoryAdapter } from '../memory/adapter.js';
import { containsSecret } from '../memory/privacy.js';
import type { MemoryRecord } from '../memory/types.js';
import { ConfirmationIntentClassifier } from '../tools/confirmation-intent.js';
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
  const memory = createMemoryRuntime(env); registry.add(new MemoryAdapter(memory.service, memory.budget));
  return { registry, timezone, memory };
}
const invocation = z.object({ invocationId: z.string().min(1).max(128), toolId: z.string().max(80), input: z.unknown() }).strict();
const cancellation = z.object({ confirmationId: z.string().uuid().optional() }).strict();
const voiceIntent = z.object({ confirmationId: z.string().uuid(), utterance: z.string().min(1).max(2000) }).strict();
const decision = z.object({ confirmationId: z.string().uuid(), approved: z.boolean() }).strict();
async function body(req: IncomingMessage): Promise<unknown> {
  if (req.headers['content-type']?.split(';')[0] !== 'application/json') throw new Error();
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const chunk of req) { bytes += chunk.length; if (bytes > 16_384) throw new Error(); chunks.push(Buffer.from(chunk)); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
export function createToolsHandler(env: NodeJS.ProcessEnv = process.env, diagnostics: { development?: boolean; sink?: TraceSink } = {}, dependencies: { runtime?: { registry: ToolRegistry; timezone: string; memory?: MemoryRuntime }; classifier?: Pick<ConfirmationIntentClassifier, 'classify'>; now?: () => number } = {}) {
  const confirmationTrace = diagnostics.development === true && env.JARVIS_CONFIRMATION_TRACE === 'true';
  const trace = confirmationTracer(confirmationTrace, diagnostics.sink);
  const { registry, timezone, memory } = dependencies.runtime ?? createToolRuntime(env);
  const classifier = dependencies.classifier ?? new ConfirmationIntentClassifier(env.OPENAI_API_KEY);
  const sessions = new Map<string, { executor: ToolExecutor; expiresAt: number; busy: boolean; seenTurns: Set<string>; workingIds: string[]; memoryGeneration: number; lastMemorySequence: number; jobs: Set<Promise<void>>; closed: boolean }>();
  const lifetime = 30 * 60_000;
  const cleanup = () => { for (const [id, session] of sessions) if (session.expiresAt <= Date.now()) { session.closed = true; session.executor.close(); sessions.delete(id); } };
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
      if (previousId) { const previous = sessions.get(previousId); if (previous) { previous.closed = true; previous.executor.close(); } sessions.delete(previousId); }
      if (sessions.size >= 10) { send(429, { error: 'Demasiadas sesiones.' }); return true; }
      const id = randomBytes(32).toString('hex');
      sessions.set(id, { executor: new ToolExecutor(registry, dependencies.now ?? Date.now, 60_000, undefined, trace), expiresAt: Date.now() + lifetime, busy: false, seenTurns: new Set(), workingIds: [], memoryGeneration: 0, lastMemorySequence: 0, jobs: new Set(), closed: false });
      res.setHeader('Set-Cookie', `jarvis_session=${id}; HttpOnly; SameSite=Strict; Path=/api/tools; Max-Age=1800${origin?.startsWith('https:') ? '; Secure' : ''}`);
      send(200, { tools: registry.descriptors().filter(tool => tool.id !== 'memory.ingest'), timezone, now: new Date().toISOString(), confirmationTrace }); return true;
    }
    const id = /(?:^|;\s*)jarvis_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie ?? '')?.[1];
    const session = id ? sessions.get(id) : undefined;
    if (!session) { send(401, { error: 'Sesión de herramientas caducada. Reconecta.' }); return true; }
    if (path === '/api/tools/session' && req.method === 'DELETE') { session.closed = true; session.executor.close(); sessions.delete(id!); send(200, { closed: true }); return true; }
    if (path === '/api/tools/activity' && req.method === 'GET') { send(200, { activity: session.executor.telemetry.snapshot(), pending: session.executor.pendingState() }); return true; }
    if (req.method !== 'POST') { send(405, { error: 'Método no permitido.' }); return true; }
    const contextualRead = path === '/api/tools/memory-context' || path === '/api/tools/memory-turn';
    if (session.busy && !contextualRead) { send(429, { error: 'Una herramienta sigue ejecutándose.' }); return true; }
    if (!contextualRead) session.busy = true;
    try {
      const input = await body(req);
      if (path === '/api/tools/memory-context') {
        const p = z.object({ query: z.string().min(1).max(500) }).strict().parse(input);
        let context = '';
        if (memory && !session.executor.pendingState()) {
          try { context = memory.service.context(await memory.service.search(p.query, memory.limit), memory.budget);
          } catch { /* Optional memory unavailable. */ }
        }
        send(200, { context });
      } else if (path === '/api/tools/memory-turn') {
        const p = z.object({ itemId: z.string().min(1).max(128), sequence: z.number().int().min(1).max(10000), observedAt: z.iso.datetime(), utterance: z.string().min(1).max(2000) }).strict().parse(input);
        if (p.sequence <= session.lastMemorySequence || Date.parse(p.observedAt) > Date.now() + 300_000 || !memory || session.executor.pendingState() || session.seenTurns.has(p.itemId) || session.seenTurns.size >= 100 || containsSecret(p.utterance)) { send(200, { context: '' }); }
        else {
          session.lastMemorySequence = p.sequence;
          session.seenTurns.add(p.itemId);
          let relevant: MemoryRecord[] = [];
          try {
            // Contextual reads are optional storage retrieval, not model tool
            // invocations; they cannot hold the foreground tool/approval lock.
            relevant = await memory.service.search(p.utterance.slice(0, 500), memory.limit);
          } catch { /* Memory failure does not break voice. */ }
          const working = /\b(it|that|they|eso|esto|ella|ellos|entrega|delivery)\b/i.test(p.utterance) ? session.workingIds : [];
          for (const recordId of working) {
            try { const r = await memory.service.get(recordId); if (!relevant.some(record => record.id === r.id)) relevant.push(r); } catch { /* Deleted/expired records are never reused. */ }
          }
          send(200, { context: memory.service.context(relevant.slice(0, memory.limit), memory.budget) });
          if (memory.automatic && session.jobs.size < 2) {
            const observedAt = new Date(Math.min(Date.parse(p.observedAt), Date.now())).toISOString();
            const memoryGeneration = session.memoryGeneration; const storeGeneration = memory.service.mutationGeneration;
            const job = (async () => {
              const candidates = await memory.extraction.extract(p.utterance, relevant.slice(0, 6), observedAt);
              for (const [index, candidate] of candidates.entries()) {
                // Extraction runs outside audio latency; commit only in an idle session.
                // Never invoke a background tool while a frozen action is pending.
                if (session.lastMemorySequence !== p.sequence || session.closed || session.busy || session.executor.pendingState() || session.expiresAt <= Date.now() || session.memoryGeneration !== memoryGeneration || memory.service.mutationGeneration !== storeGeneration) return;
                if (!p.utterance.includes(candidate.evidence)) continue;
                {
                  // The actual transcript is the provenance. The adapter sees verified
                  // source only through this private server invocation, not model input.
                  const id = 'memory-auto-' + p.itemId + '-' + index;
                  const result = await session.executor.invoke(id, 'memory.ingest', { candidate: candidate.candidate, source: { kind: candidate.sourceKind, evidence: candidate.evidence, observedAt }, guardGeneration: storeGeneration }, { background: true });
                  if (result.status === 'success' && (result.data as { remembered?: boolean }).remembered) {
                    const saved = result.data as { memory: { id: string } };
                    session.workingIds = [saved.memory.id, ...session.workingIds.filter(value => value !== saved.memory.id)].slice(0, 6);
                  }
                }
              }
            })().catch(() => undefined);
            session.jobs.add(job); void job.finally(() => session.jobs.delete(job));
          }
        }
      } else if (path === '/api/tools/invoke') {
        const p = invocation.parse(input);
        // Model-facing requests cannot forge provenance used by automatic extraction.
        if (p.toolId === 'memory.ingest') throw new Error();
        if (p.toolId === 'memory.forget' || p.toolId === 'memory.update') ++session.memoryGeneration;
        trace({ event: 'server POST /invoke', reason: 'request' }); send(200, await session.executor.invoke(p.invocationId, p.toolId, p.input));
      } else if (path === '/api/tools/intent') {
        const p = voiceIntent.parse(input); const pending = session.executor.pendingState();
        if (!pending || pending.confirmationId !== p.confirmationId) { send(200, { confirmationId: p.confirmationId, intent: 'ambiguous' }); }
        else {
          trace({ event: 'server POST /intent', reason: 'classifying', pendingId: p.confirmationId });
          const intent = await classifier.classify(pending.summary, p.utterance);
          // A classification arriving after expiry, close or replacement has no authority.
          const current = session.executor.pendingState();
          const boundIntent = current?.confirmationId === p.confirmationId ? intent : 'ambiguous';
          trace({ event: 'server intent.result', reason: 'classified', pendingId: p.confirmationId, classification: boundIntent });
          send(200, { confirmationId: p.confirmationId, intent: boundIntent });
        }
      } else if (path === '/api/tools/decision') {
        const p = decision.parse(input); trace({ event: 'server POST /decision', reason: p.approved ? 'approved' : 'rejected', pendingId: p.confirmationId }); send(200, await session.executor.decide(p.confirmationId, p.approved));
      } else if (path === '/api/tools/cancel') {
        const p = cancellation.parse(input); const current = session.executor.pendingState();
        if (p.confirmationId && current?.confirmationId !== p.confirmationId) send(200, { cancelled: false });
        else { trace({ event: 'server POST /cancel', reason: 'request', pendingId: p.confirmationId }); session.executor.invalidate(); send(200, { cancelled: true }); }
      }
      else send(404, { error: 'Ruta desconocida.' });
    } catch { send(400, { error: 'Solicitud inválida.' }); }
    finally { if (!contextualRead) session.busy = false; }
    return true;
  };
  return { handle, close: () => { clearInterval(timer); for (const session of sessions.values()) { session.closed = true; session.executor.close(); } sessions.clear(); } };
}
