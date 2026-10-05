import { IsolatedBrowserProvider } from '../browser/isolated.js';
import { AttachedChromeProvider } from '../browser/attached/provider.js';
import { NativeTransport } from '../browser/attached/transport.js';
import { randomUUID } from 'node:crypto';
import { BrowserDiagnostics } from '../browser/diagnostics.js';
import { isBrowserTool, browserCode } from '../diagnostics/browser.js';
import type { BrowserDiagnosticSink } from '../diagnostics/browser.js';
import { browserOptions } from '../browser/local.js';
import { BrowserAdapter } from '../tools/adapters/browser.js';
import { preferenceSchema } from '../memory/preferences.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { MemoryDiagnostics } from '../diagnostics/memory.js';
import { ToolError } from '../tools/types.js';
import type { MemoryOperation } from '../diagnostics/memory.js';
import type { MemoryDiagnosticSink } from '../diagnostics/memory.js';
import { confirmationTracer } from '../diagnostics/confirmation.js';
import type { TraceSink } from '../diagnostics/confirmation.js';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { ToolRegistry } from '../tools/registry.js';
import { createMemoryRuntime } from '../memory/runtime.js';
import type { MemoryRuntime } from '../memory/runtime.js';
import { MemoryAdapter } from '../memory/adapter.js';
import { literalIdentifiers, validateSpelling } from '../memory/spelling.js';
import { MemoryValidationError, validationField } from '../memory/validation.js';
import { candidateSchema } from '../memory/types.js';
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
export function createToolRuntime(env: NodeJS.ProcessEnv = process.env, diagnostics = new MemoryDiagnostics(), browserDiagnostics = new BrowserDiagnostics(env.BROWSER_TRACE === 'true')) {
  const timezone = validateTimezone(env.USER_TIMEZONE ?? 'Europe/Madrid');
  const writePolicy = env.TOOL_CONFIRM_WRITES ?? 'true';
  if (!['true', 'false'].includes(writePolicy)) throw new Error('TOOL_CONFIRM_WRITES must be true or false');
  const registry = new ToolRegistry();
  const mode = env.BROWSER_PROVIDER ?? 'isolated'; if (!['isolated', 'attached'].includes(mode)) throw new Error('Invalid BROWSER_PROVIDER');
  const options = browserOptions(env);
  const native = mode === 'attached' ? new NativeTransport(env.ATLAS_BROWSER_HOST_PATH, env.ATLAS_BROWSER_EXTENSION_ID, { diagnostic: line => console.info(line) }) : undefined;
  if (native && options.enabled) native.initialize();
  const provider = native ? new AttachedChromeProvider(native, options.enabled, env.BROWSER_CONNECTION_ID) : new IsolatedBrowserProvider(options, undefined, browserDiagnostics);
  const browser = new BrowserAdapter(provider, browserDiagnostics); registry.add(browser);
  registry.add(new WebSearchAdapter(env.OPENAI_API_KEY, env.OPENAI_SEARCH_MODEL ?? 'gpt-4.1'));
  const auth = new GoogleAuth(googleConfig(env));
  registry.add(new CalendarAdapter(new GoogleCalendarTransport(() => auth.token()), timezone, env.GOOGLE_CALENDAR_ID ?? 'primary', writePolicy === 'true'));
  const gmail = new GmailAccountStore(env);
  registry.add(new GmailAdapter(gmail, new GoogleGmailTransport(gmail), timezone, writePolicy === 'true'));
  const memory = createMemoryRuntime(env, diagnostics); registry.add(new MemoryAdapter(memory.service, memory.budget, diagnostics));
  return { registry, timezone, memory, browser };
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
export function createToolsHandler(env: NodeJS.ProcessEnv = process.env, diagnostics: { development?: boolean; sink?: TraceSink; memorySink?: MemoryDiagnosticSink; browserSink?: BrowserDiagnosticSink } = {}, dependencies: { runtime?: { registry: ToolRegistry; timezone: string; memory?: MemoryRuntime; browser?: BrowserAdapter }; classifier?: Pick<ConfirmationIntentClassifier, 'classify'>; now?: () => number } = {}) {
  const confirmationTrace = diagnostics.development === true && env.JARVIS_CONFIRMATION_TRACE === 'true';
  const trace = confirmationTracer(confirmationTrace, diagnostics.sink);
  const memoryDiagnostics = new MemoryDiagnostics(diagnostics.development === true, diagnostics.memorySink, env.JARVIS_MEMORY_PROFILE === 'true');
  const browserDiagnostics = dependencies.runtime?.browser?.diagnostics ?? new BrowserDiagnostics(env.BROWSER_TRACE === 'true', diagnostics.browserSink);
  const { registry, timezone, memory, browser } = dependencies.runtime ?? createToolRuntime(env, memoryDiagnostics, browserDiagnostics);
  const classifier = dependencies.classifier ?? new ConfirmationIntentClassifier(env.OPENAI_API_KEY);
  const sessions = new Map<string, { browserSessionId: string; executor: ToolExecutor; expiresAt: number; busy: boolean; seenTurns: Set<string>; workingIds: string[]; memoryGeneration: number; lastMemorySequence: number; spellingEvidence: string; jobs: Set<Promise<void>>; closed: boolean }>();
  const lifetime = 30 * 60_000;
  const cleanup = () => { for (const [id, session] of sessions) if (session.expiresAt <= Date.now()) { browserDiagnostics.lifecycle(session.executor, 'session_expired'); session.closed = true; session.executor.close(); void browser?.endSession(session.browserSessionId).catch(() => {}); sessions.delete(id); } };
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
      if (previousId) { const previous = sessions.get(previousId); if (previous) { browserDiagnostics.lifecycle(previous.executor, 'session_replaced'); previous.closed = true; previous.executor.close(); void browser?.endSession(previous.browserSessionId).catch(() => {}); } sessions.delete(previousId); }
      if (sessions.size >= 10) { send(429, { error: 'Demasiadas sesiones.' }); return true; }
      const id = randomBytes(32).toString('hex');
      sessions.set(id, { browserSessionId: randomUUID(), executor: new ToolExecutor(registry, dependencies.now ?? Date.now, 60_000, undefined, trace), expiresAt: Date.now() + lifetime, busy: false, seenTurns: new Set(), workingIds: [], memoryGeneration: 0, lastMemorySequence: 0, spellingEvidence: '', jobs: new Set(), closed: false });
      res.setHeader('Set-Cookie', `jarvis_session=${id}; HttpOnly; SameSite=Strict; Path=/api/tools; Max-Age=1800${origin?.startsWith('https:') ? '; Secure' : ''}`);
      send(200, { tools: registry.descriptors().filter(tool => tool.id !== 'memory.ingest' && tool.id !== 'browser.resume'), timezone, now: new Date().toISOString(), confirmationTrace, browserTrace: browserDiagnostics.enabled }); return true;
    }
    const id = /(?:^|;\s*)jarvis_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie ?? '')?.[1];
    const session = id ? sessions.get(id) : undefined;
    if (!session) { send(401, { error: 'Sesión de herramientas caducada. Reconecta.' }); return true; }
    if (path === '/api/tools/session' && req.method === 'DELETE') { browserDiagnostics.lifecycle(session.executor, 'session_closed'); session.closed = true; session.executor.close(); void browser?.endSession(session.browserSessionId).catch(() => {}); sessions.delete(id!); send(200, { closed: true }); return true; }
    if (path === '/api/tools/activity' && req.method === 'GET') { send(200, { activity: session.executor.telemetry.snapshot(), pending: session.executor.pendingState(), ...(browser?.state(session.browserSessionId) ? { browser: browser.state(session.browserSessionId) } : {}) }); return true; }
    if (req.method !== 'POST') { send(405, { error: 'Método no permitido.' }); return true; }
    const contextualRead = path === '/api/tools/memory-context' || path === '/api/tools/memory-turn';
    if (session.busy && !contextualRead) { browserDiagnostics.lifecycle(session.executor, 'http_busy'); send(429, { error: 'Una herramienta sigue ejecutándose.' }); return true; }
    if (!contextualRead) session.busy = true;
    try {
      const input = await body(req);
      if (path === '/api/tools/memory-context') {
        const p = z.object({ query: z.string().min(1).max(500) }).strict().parse(input);
        let context = ''; const lookupStarted = performance.now();
        if (memory && !session.executor.pendingState()) {
          try { context = memory.service.context(await memory.service.search(p.query, memory.limit), memory.budget);
          } catch (error) { memoryDiagnostics.failure('context', 'lookup', error, lookupStarted); }
        }
        send(200, { context });
      } else if (path === '/api/tools/memory-turn') {
        const p = z.object({ itemId: z.string().min(1).max(128), sequence: z.number().int().min(1).max(10000), observedAt: z.iso.datetime(), utterance: z.string().min(1).max(2000) }).strict().parse(input);
        if (p.sequence <= session.lastMemorySequence || Date.parse(p.observedAt) > Date.now() + 300_000 || !memory || session.executor.pendingState() || session.seenTurns.has(p.itemId) || session.seenTurns.size >= 100 || containsSecret(p.utterance)) { send(200, { context: '' }); }
        else {
          session.lastMemorySequence = p.sequence;
          // Keep only literal identifiers from the latest accepted user turn, not
          // a conversation archive. Model-supplied evidence cannot override them.
          session.spellingEvidence = literalIdentifiers(p.utterance).join(' ');
          session.seenTurns.add(p.itemId);
          let relevant: MemoryRecord[] = []; const lookupStarted = performance.now();
          const working = /\b(it|that|they|eso|esto|ella|ellos|entrega|delivery)\b/i.test(p.utterance) ? session.workingIds : [];
          try {
            // Contextual reads are optional storage retrieval, not model tool
            // invocations; they cannot hold the foreground tool/approval lock.
            relevant = await memory.service.contextualSearch(p.utterance.slice(0, 500), memory.limit, working);
          } catch (error) { memoryDiagnostics.failure('context', 'lookup', error, lookupStarted); }
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
        if (p.toolId === 'memory.ingest' || p.toolId === 'browser.resume') throw new Error();
        if ((p.toolId === 'memory.update' || (p.toolId === 'memory.remember' && !(p.input as { preference?: unknown })?.preference)) && session.spellingEvidence) {
          const candidate = candidateSchema.parse((p.input as { candidate?: unknown })?.candidate);
          validateSpelling(candidate, session.spellingEvidence);
        }
        if (p.toolId === 'memory.forget' || p.toolId === 'memory.update') ++session.memoryGeneration;
        trace({ event: 'server POST /invoke', reason: 'request' });
        const started = performance.now();
        const header = req.headers['x-atlas-browser-request'];
        const clientRequest = typeof header === 'string' && /^[1-9]\d{0,5}$/.test(header) ? Number(header) : undefined;
        const browserCall = isBrowserTool(p.toolId) && browserDiagnostics.enabled ? browserDiagnostics.received(session.executor, p.invocationId, p.toolId, clientRequest) : undefined;
        if (browserCall) res.setHeader('X-Atlas-Browser-Call', browserCall.call);
        const run = async () => {
          if (browserCall) browserDiagnostics.event('http_received', 'RUNNING');
          const invoke = () => session.executor.invoke(p.invocationId, p.toolId, p.input);
          const result = browser ? await browser.inSession(session.browserSessionId, invoke) : await invoke();
          if (browserCall) browserDiagnostics.event('executor_result', result.status === 'error' ? browserCode(result.category) : 'OK', performance.now() - started);
          return result;
        };
        const result = browserCall ? await browserDiagnostics.inCall(session.executor, browserCall, run) : await run();
        if (browserCall) await browserDiagnostics.inCall(session.executor, browserCall, async () => { browserDiagnostics.event('http_result', result.status === 'error' ? browserCode(result.category) : 'OK', performance.now() - started); });
        if (p.toolId.startsWith('memory.') && result.status === 'error') {
          const capability = registry.resolve(p.toolId)?.capability;
          const operation: MemoryOperation = ['search', 'get', 'remember', 'update', 'forget'].includes(capability ?? '') ? capability as MemoryOperation : 'context';
          const parsed = result.category === 'INVALID_INPUT' ? registry.resolve(p.toolId)?.schema.safeParse(p.input) : undefined;
          const preference = p.toolId === 'memory.remember' && (p.input as { preference?: unknown })?.preference;
          const preferenceResult = preference ? preferenceSchema.safeParse(preference) : undefined;
          const field = preferenceResult && !preferenceResult.success ? validationField(['preference', ...(preferenceResult.error.issues[0]?.path ?? [])]) : validationField(parsed && !parsed.success ? parsed.error.issues[0]?.path ?? [] : []);
          const issue = parsed && !parsed.success ? new MemoryValidationError(field, 'schema') : new ToolError(result.category);
          memoryDiagnostics.failure(operation, result.category === 'INVALID_INPUT' ? 'validation' : 'execute', issue, started);
        }
        send(200, result);
      } else if (path === '/api/tools/browser-resume') {
        const p = z.object({ handoffId: z.string().uuid(), utterance: z.string().max(80) }).strict().parse(input);
        if (session.executor.pendingState() || !/^(listo|lista|ya est[aá]|done)[.!\s]*$/i.test(p.utterance.trim()) || !browser) throw new Error();
        const result = await browser.inSession(session.browserSessionId, () => session.executor.invoke(randomUUID(), 'browser.resume', { handoffId: p.handoffId }));
        send(200, result.status === 'success' ? result.data : { outcome: 'ERROR', code: 'REJECTED' });
      } else if (path === '/api/tools/intent') {
        const p = voiceIntent.parse(input); const pending = session.executor.pendingState();
        if (!pending || pending.confirmationId !== p.confirmationId) { send(200, { confirmationId: p.confirmationId, intent: 'ambiguous' }); }
        else {
          trace({ event: 'server POST /intent', reason: 'classifying', pendingId: p.confirmationId });
          const toolId = session.executor.pendingToolId();
          const capability = toolId?.startsWith('memory.') ? registry.resolve(toolId)?.capability : undefined;
          const intent = capability ? await memoryDiagnostics.run(capability as MemoryOperation, 'confirmation', () => classifier.classify(pending.summary, p.utterance)) : await classifier.classify(pending.summary, p.utterance);
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
  return { handle, close: () => { void browser?.close().catch(() => undefined); clearInterval(timer); for (const session of sessions.values()) { browserDiagnostics.lifecycle(session.executor, 'session_closed'); session.closed = true; session.executor.close(); void browser?.endSession(session.browserSessionId).catch(() => {}); } sessions.clear(); } };
}
