import { conflictSchema, timingSchema, observationResultSchema } from '../browser/attached/protocol.js';
import type { TraceSink } from '../diagnostics/confirmation.js';
import { randomUUID } from 'node:crypto';
import { requiresConfirmation } from './permissions.js';
import { ToolTelemetry } from './telemetry.js';
import type { ToolActivity } from './telemetry.js';
import { ToolError } from './types.js';
import type { ToolDefinition, ToolResult, ErrorCategory } from './types.js';
import type { ToolRegistry } from './registry.js';
const messages: Record<ErrorCategory, string> = {
  EXECUTION_UNKNOWN: 'Se perdió el resultado de la operación. No afirmes éxito ni la repitas automáticamente; verifica el estado con el usuario.',
  INVALID_INPUT: 'Datos inválidos. Aclara la solicitud.', UNCONFIGURED: 'Esta integración no está configurada.',
  UPSTREAM: 'No se pudo recuperar información o completar la acción. No asumas que se realizó.',
  TIMEOUT: 'La operación tardó demasiado. Su resultado puede ser incierto; comprueba el estado antes de repetir una escritura.',
  AMBIGUOUS: 'Hay varias coincidencias. Pide al usuario que elija una.', CONFLICT: 'La información cambió o la solicitud no coincide. Vuelve a consultarla.',
  EXPIRED: 'Confirmación inválida o caducada. Solicita la acción de nuevo.', REJECTED: 'Acción cancelada. No se ha ejecutado.', LIMIT: 'Límite de herramientas de esta sesión alcanzado.'
};
export function safeError(error: unknown): ToolResult {
  const category = error instanceof ToolError ? error.category : 'UPSTREAM';
  const detail = error instanceof ToolError && category === 'CONFLICT' ? error.browserRecovery : undefined;
  const parsed = conflictSchema.safeParse(detail && { reason: detail.reason, execution: detail.execution });
  const browserRecovery = detail && parsed.success && Number.isInteger(detail.remainingRecoveries) && detail.remainingRecoveries >= 0 && detail.remainingRecoveries <= 2 && typeof detail.recoverable === 'boolean' && detail.recoverable === (detail.remainingRecoveries > 0)
    ? { ...parsed.data, remainingRecoveries: detail.remainingRecoveries, recoverable: detail.recoverable } : undefined;
  const observation = observationResultSchema.safeParse(error instanceof ToolError ? error.browserObservation : undefined);
  return { status: 'error', category, ...(observation.success ? { browserObservation: observation.data } : {}), message: observation.success && observation.data.status === 'FAILED' && observation.data.reason === 'STEP_PENDING' ? 'Existe un paso pendiente. No repitas acciones completadas ni cambies de operación para reiniciar el presupuesto.' : browserRecovery ? browserRecovery.recoverable ? browserRecovery.reason === 'SNAPSHOT_CONSUMED' ? 'El contexto anterior ya fue consumido; no atribuyas esto a cambios de página ni repitas una acción completada. Usa las refs de la observación nueva.' : 'La acción no se ejecutó. Resuelve el control en la observación nueva en silencio; no es un control bloqueado.' : 'La acción no se ejecutó. Se agotaron las dos recuperaciones de este paso; detente sin más intentos.' : messages[category], ...(browserRecovery ? { browserRecovery } : {}) };
}
interface Pending { id: string; tool: ToolDefinition; input: unknown; expiresAt: number; pendingAt: number; row: ToolActivity }
export class ToolExecutor {
  private pending?: Pending;
  private calls = new Map<string, { fingerprint: string; result: Promise<ToolResult> }>();
  private controllers = new Set<AbortController>();
  private closed = false;
  private foregroundCalls = 0;
  private backgroundCalls = 0;
  private revision = 0;
  constructor(private readonly registry: ToolRegistry, private readonly now = Date.now, private readonly confirmationMs = 60_000, readonly telemetry = new ToolTelemetry(), private readonly trace: TraceSink = () => {}) {}
  invoke(id: string, toolId: string, input: unknown, options: { background?: true } = {}): Promise<ToolResult> {
    const fingerprint = JSON.stringify([toolId, input]);
    const previous = this.calls.get(id);
    if (previous) return previous.fingerprint === fingerprint ? previous.result : Promise.resolve(safeError(new ToolError('CONFLICT')));
    const background = options.background === true;
    if (background) {
      const tool = this.registry.resolve(toolId);
      // Server-only maintenance cannot create/approve a confirmation or consume
      // the user's 100-call budget. Both budgets and the replay cache remain bounded.
      if (!tool || (tool.permission !== 'READ' && !(tool.permission === 'WRITE' && tool.confirm === false && !tool.confirmWhen))) return Promise.resolve(safeError(new ToolError('INVALID_INPUT')));
      if (this.pending) return Promise.resolve(safeError(new ToolError('CONFLICT')));
    }
    if (this.closed || (background ? this.backgroundCalls >= 256 : this.foregroundCalls >= 100)) return Promise.resolve(safeError(new ToolError('LIMIT')));
    if (background) this.backgroundCalls++;
    else { this.foregroundCalls++; this.invalidate('rejected'); } // New foreground requests still invalidate.

    const result = this.start(id, toolId, input);
    this.calls.set(id, { fingerprint, result });
    return result;
  }
  private async bounded<T>(tool: ToolDefinition, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController(); this.controllers.add(controller);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([operation(controller.signal), new Promise<never>((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new ToolError('TIMEOUT')); }, tool.timeoutMs ?? 20_000);
        controller.signal.addEventListener('abort', () => reject(new ToolError('TIMEOUT')), { once: true });
      })]);
    } finally { clearTimeout(timer); this.controllers.delete(controller); }
  }
  private async start(id: string, toolId: string, raw: unknown): Promise<ToolResult> {
    const revision = this.revision;
    const tool = this.registry.resolve(toolId);
    if (!tool) return safeError(new ToolError('INVALID_INPUT'));
    const row: ToolActivity = { invocationId: id, toolId, integration: tool.integration, permission: tool.permission,
      startedAt: this.now(), status: 'running', confirmationRequired: requiresConfirmation(tool), confirmation: requiresConfirmation(tool) ? 'waiting' : 'not_required' };
    this.telemetry.record(row);
    try {
      const parsed = tool.schema.safeParse(raw);
      if (!parsed.success) throw new ToolError('INVALID_INPUT');
      const input = tool.prepare ? await this.bounded(tool, signal => tool.prepare!(parsed.data, signal)) : parsed.data;
      row.preparationMs = this.now() - row.startedAt;
      if (this.closed || revision !== this.revision) throw new ToolError('EXPIRED');
      row.confirmationRequired = requiresConfirmation(tool, input);
      row.confirmation = row.confirmationRequired ? 'waiting' : 'not_required';
      if (row.confirmationRequired) {
        this.invalidate('rejected');
        const pending = { id: randomUUID(), tool, input, expiresAt: this.now() + this.confirmationMs, pendingAt: this.now(), row };
        this.trace({ event: 'executor.prepare', reason: 'prepared', pendingId: pending.id });
        tool.confirmationLifecycle?.pending(input, pending.id, pending.expiresAt);
        this.pending = pending; row.status = 'pending';
        return { status: 'pending', confirmationId: pending.id, summary: tool.summarize?.(input) ?? `¿Confirmas ${tool.name}?`, expiresAt: pending.expiresAt };
      }
      return await this.run(tool, input, row);
    } catch (error) { return this.finishError(row, error); }
  }
  pendingState() {
    if (this.pending && this.pending.expiresAt <= this.now()) this.invalidate('expired');
    const p = this.pending;
    return p ? { confirmationId: p.id, summary: p.tool.summarize?.(p.input) ?? p.tool.name, expiresAt: p.expiresAt } : null;
  }
  pendingToolId(): string | undefined { return this.pending?.tool.id; }
  async decide(id: string, approved: boolean): Promise<ToolResult> {
    const pending = this.pending;
    this.trace({ event: 'executor.decision', reason: approved ? 'approved' : 'rejected', pendingId: id });
    if (!pending || pending.id !== id || this.closed) return safeError(new ToolError('EXPIRED'));
    pending.row.confirmationWaitMs = this.now() - pending.pendingAt;
    this.pending = undefined; // Consume before awaiting: concurrent/replayed decisions cannot execute twice.
    if (pending.expiresAt <= this.now()) { try { pending.tool.confirmationLifecycle?.invalidated(pending.input, 'expired'); } catch { /* Expiry never restores approval. */ } pending.row.confirmation = 'expired'; return this.finishError(pending.row, new ToolError('EXPIRED')); }
    if (!approved) { try { pending.tool.confirmationLifecycle?.decided(pending.input, id, false); } catch { /* Rejection never grants approval. */ } pending.row.confirmation = 'rejected'; return this.finishError(pending.row, new ToolError('REJECTED')); }
    try { pending.tool.confirmationLifecycle?.decided(pending.input, id, true); } catch (error) { return this.finishError(pending.row, error); }
    pending.row.confirmation = 'granted';
    return this.run(pending.tool, pending.input, pending.row);
  }
  private async run(tool: ToolDefinition, input: unknown, row: ToolActivity): Promise<ToolResult> {
    row.status = 'running'; const started = this.now();
    try {
      const data = await this.bounded(tool, signal => tool.execute(input, signal));
      if (tool.integration === 'browser') { const timings = timingSchema.safeParse(data && typeof data === 'object' && 'browserTimings' in data ? data.browserTimings : undefined); if (timings.success) row.timings = timings.data; }
      row.executionMs = this.now() - started; row.status = 'success'; this.end(row); return { status: 'success', data };
    } catch (error) { row.executionMs = this.now() - started; return this.finishError(row, error); }
  }
  private end(row: ToolActivity): void { row.endedAt = this.now(); row.durationMs = row.endedAt - row.startedAt; }
  private finishError(row: ToolActivity, error: unknown): ToolResult {
    const result = safeError(error); row.status = 'error';
    if (result.status === 'error') { row.errorCategory = result.category; if (result.browserRecovery) row.reason = result.browserRecovery.reason; }
    const timings = timingSchema.safeParse(error instanceof ToolError ? error.browserTimings : undefined); if (timings.success) row.timings = timings.data;
    this.end(row); return result;
  }
  invalidate(reason: 'rejected' | 'expired' = 'rejected'): void {
    this.trace({ event: 'executor.invalidate', reason, pendingId: this.pending?.id });
    ++this.revision;
    const pending = this.pending;
    this.pending = undefined; // Remove authority before trusted notifications.
    if (pending) {
      try { pending.tool.confirmationLifecycle?.invalidated(pending.input, reason); } catch { /* Invalidated approval cannot be restored by a callback failure. */ }
      pending.row.confirmationWaitMs = this.now() - pending.pendingAt;
      pending.row.confirmation = reason;
      this.finishError(pending.row, new ToolError(reason === 'expired' ? 'EXPIRED' : 'REJECTED'));
    }
  }
  close(): void { this.trace({ event: 'executor.close', reason: 'session_closed', pendingId: this.pending?.id }); this.closed = true; this.invalidate(); for (const controller of this.controllers) controller.abort(); }
}
