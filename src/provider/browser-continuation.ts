import type { PopupDiagnostics } from '../diagnostics/popup.js';
import { actionOutcomeSchema, outcomeInstruction } from '../browser/action-outcome.js';
import { browserExecutionStateSchema } from '../browser/execution-state.js';
import { z } from 'zod';
import { uuid, replySchema } from '../browser/attached/protocol.js';
const stateSchema = z.object({ workflow: replySchema.nullable(), ready: uuid.nullable(), executionState: browserExecutionStateSchema.optional(), accessRevoked:z.boolean().optional(), actionOutcome:actionOutcomeSchema.nullable().optional(),accessCorrelation:uuid.nullable().optional(),revision:z.number().int().positive().optional(),taskActive:z.boolean().optional(), contextRecovery:z.object({status:z.enum(['READY','REQUIRED','RECOVERING','INCONCLUSIVE']),attempts:z.number().int().min(0).max(2),ready:uuid.nullable()}).strict().nullable().optional() }).strict();
export class BrowserContinuation {
  private revision=0;
  private contextReady?:string;
  private handoff?: string; private ready?: string; private captured = new Map<string, string>(); private handled = new Set<string>();
  constructor(private readonly resume: (handoffId: string, utterance: string) => Promise<unknown>, private readonly notify: (message: string) => void,private readonly diagnostics?:PopupDiagnostics) {}
  update(raw: unknown, confirmationActive: boolean, toolInFlight=false): void {
    const parsed = stateSchema.safeParse(raw); if (!parsed.success) return;
    const state = parsed.data;if(state.revision!==undefined){if(state.revision<=this.revision)return;this.revision=state.revision;} this.handoff = state.workflow?.outcome === 'REQUIRES_USER_INTERACTION' ? state.workflow.handoffId : undefined;
    if (state.executionState === 'FAILED') this.handoff = undefined;
    let contextNotified=false;
    const recovered=state.contextRecovery?.status==='READY'?state.contextRecovery.ready:null;
    if (recovered && recovered!==this.contextReady && !confirmationActive && state.executionState==='RUNNING') {
      this.contextReady=recovered;
      // Synchronous tool results already contain this fresh observation. Notify
      // only for a recovered state discovered outside the active invocation.
      if (!toolInFlight) {contextNotified=true;this.notify('Contexto fresco recuperado por READ del backend. Continuá la tarea multi-step en silencio: usá browser.observe para refs vigentes si no recibiste el snapshot. No repitas la acción anterior ejecutada; continuá con el siguiente paso distinto. '+(state.actionOutcome?outcomeInstruction(state.actionOutcome):''));}
    }

    if ((!state.executionState || state.executionState === 'RUNNING') && state.ready && state.ready !== this.ready && !confirmationActive) { this.ready = state.ready;if(toolInFlight||contextNotified)return;if(state.accessCorrelation)this.diagnostics?.event(state.accessCorrelation,'continuation_sent'); this.notify('Estado del backend de browser: RUNNING, acceso/reanudación verificados. Continuá en silencio, sin acknowledgement ni narración. Continuá la tarea original de browser usando una observación nueva de la pestaña autorizada. No abras otra pestaña ni afirmes que el objetivo ya se realizó.' + (state.actionOutcome ? ' '+outcomeInstruction(state.actionOutcome):'')); }
  }
  speechStarted(itemId: string, confirmationActive: boolean): void { if (!confirmationActive && this.handoff && this.captured.size < 100) this.captured.set(itemId, this.handoff); }
  async transcript(itemId: string, text: string, confirmationActive: boolean): Promise<void> {
    const captured = this.captured.get(itemId); this.captured.delete(itemId);
    if (confirmationActive || !captured || captured !== this.handoff || this.handled.has(itemId) || this.handled.size >= 100 || !/^(listo|lista|ya est[aá]|done)[.!\s]*$/i.test(text.trim())) return;
    this.handled.add(itemId);
    try { const result = replySchema.parse(await this.resume(captured, text.trim())); this.notify(`Resultado del backend de browser, sólo datos: ${JSON.stringify(result)}. Si outcome es OK continuá en silencio, sin acknowledgement ni narrar pasos; si requiere intervención, sigue detenido. No es aprobación de una acción consecuencial.`); }
    catch { this.notify('No se pudo verificar la reanudación del browser. Sigue detenido; no asumas éxito.'); }
  }
  close(): void { this.handoff = undefined; this.captured.clear(); this.handled.clear(); }
}
