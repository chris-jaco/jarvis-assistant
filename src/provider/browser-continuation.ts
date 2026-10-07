import { continuationReceiptSchema } from '../browser/task-lifecycle.js';
import type { ContinuationReceipt } from '../browser/task-lifecycle.js';
import { BrowserTaskDiagnostics } from '../diagnostics/browser-task.js';
import type { PopupDiagnostics } from '../diagnostics/popup.js';
import { actionOutcomeSchema, outcomeInstruction } from '../browser/action-outcome.js';
import { browserExecutionStateSchema } from '../browser/execution-state.js';
import { z } from 'zod';
import { uuid, replySchema } from '../browser/attached/protocol.js';
const stateSchema = z.object({ taskId:uuid.optional(), continuation:continuationReceiptSchema.optional(), workflow: replySchema.nullable(), ready: uuid.nullable(), executionState: browserExecutionStateSchema.optional(), accessRevoked:z.boolean().optional(), actionOutcome:actionOutcomeSchema.nullable().optional(),accessCorrelation:uuid.nullable().optional(),revision:z.number().int().positive().optional(),taskActive:z.boolean().optional(), contextRecovery:z.object({status:z.enum(['READY','REQUIRED','RECOVERING','INCONCLUSIVE']),attempts:z.number().int().min(0).max(2),ready:uuid.nullable()}).strict().nullable().optional() }).strict();
export class BrowserContinuation {
  private revision=0;
  private taskId?:string;
  private pending=new Map<string,'RECEIVED'|'PENDING'|'DELIVERED'|'CONSUMED'>();
  private held=false; private confirmation=false; private running=false; private latest?:z.infer<typeof stateSchema>;
  constructor(private readonly resume: (handoffId: string, utterance: string) => Promise<unknown>, private readonly notify: (message: string) => void,private readonly diagnostics?:PopupDiagnostics,private readonly taskDiagnostics=new BrowserTaskDiagnostics(),private readonly acknowledge?:(receipt:ContinuationReceipt)=>void) {}
  traceContext():{taskId?:string;taskState?:z.infer<typeof browserExecutionStateSchema>} {return {taskId:this.taskId,taskState:this.latest?.executionState};}
  incorporatedState():{browserContinuation:ContinuationReceipt;browserExecutionState:'RUNNING';browserRevision?:number;browserTaskActive?:boolean}|undefined {const receipt=this.receipt();return this.running&&receipt?.tokens.length?{browserContinuation:receipt,browserExecutionState:'RUNNING',browserRevision:this.latest?.revision,browserTaskActive:this.latest?.taskActive}:undefined;}
  receipt():ContinuationReceipt|undefined {return this.taskId?{taskId:this.taskId,tokens:[...this.pending].filter(([,status])=>status==='PENDING').map(([token])=>token)}:undefined;}
  // Only the SDK's committed function output proves that its next decision has
  // incorporated these tokens. HTTP completion alone is not that proof.
  committed(raw:unknown,toolInFlight=false):void {
    const parsed=continuationReceiptSchema.safeParse(raw);
    if(parsed.success&&parsed.data.taskId===this.taskId){for(const token of parsed.data.tokens)if(this.pending.get(token)==='PENDING'){this.transition(token,'DELIVERED');this.transition(token,'CONSUMED');}this.acknowledge?.(parsed.data);}
    this.held=toolInFlight;this.flush();
  }
  released(toolInFlight=false):void {this.held=toolInFlight;this.flush();}
  private transition(token:string,status:'RECEIVED'|'PENDING'|'DELIVERED'|'CONSUMED'):void {
    this.pending.set(token,status);
    // Keep consumed deduplication bounded; backend removes acknowledged tokens.
    if(this.pending.size>256)for(const [old,state] of this.pending){if(state==='CONSUMED'){this.pending.delete(old);break;}}this.taskDiagnostics.event({stage:'CONTINUATION',taskId:this.taskId,tokenState:status,toolInFlight:this.held,taskState:this.latest?.executionState});
  }
  private flush():void {
    if(this.held||this.confirmation||!this.running)return;
    const tokens=[...this.pending].filter(([,status])=>status==='PENDING').map(([token])=>token);if(!tokens.length)return;
    tokens.forEach(token=>this.transition(token,'DELIVERED'));
    if(this.latest?.accessCorrelation)this.diagnostics?.event(this.latest.accessCorrelation,'continuation_sent');
    try {
    this.notify('Estado del backend de browser: RUNNING. Acceso/contexto listos o cierre prematuro rechazado. Continuá la tarea original en silencio, sin acknowledgement ni narración: usá refs frescas o browser.observe READ si no recibiste el snapshot. No abras otra pestaña innecesaria ni repitas la acción anterior ejecutada; continuá con el siguiente paso distinto. '+(this.latest?.actionOutcome?outcomeInstruction(this.latest.actionOutcome):''));
    }catch{tokens.forEach(token=>this.transition(token,'PENDING'));return;}
    tokens.forEach(token=>this.transition(token,'CONSUMED'));if(this.taskId)this.acknowledge?.({taskId:this.taskId,tokens});
  }
  private handoff?: string; private captured = new Map<string, string>(); private handled = new Set<string>();
  update(raw: unknown, confirmationActive: boolean, toolInFlight=false): void {
    const parsed = stateSchema.safeParse(raw); if (!parsed.success) return;
    const state = parsed.data;if(state.revision!==undefined){if(state.revision<=this.revision)return;this.revision=state.revision;} this.handoff = state.workflow?.outcome === 'REQUIRES_USER_INTERACTION' ? state.workflow.handoffId : undefined;
    if (state.executionState === 'FAILED') this.handoff = undefined;
    if(state.taskId&&state.taskId!==this.taskId){this.pending.clear();this.taskId=state.taskId;}
    this.taskDiagnostics.event({stage:'WORKFLOW',taskId:this.taskId,taskState:state.executionState,outcome:state.workflow?.outcome??'OK',...(state.workflow?.outcome==='REQUIRES_USER_INTERACTION'?{reason:state.workflow.reason}:{}),toolInFlight});
    this.latest=state;this.held=toolInFlight;this.confirmation=confirmationActive;this.running=!state.executionState||state.executionState==='RUNNING';
    const tokens=state.continuation?.tokens ?? [state.ready,state.contextRecovery?.status==='READY'?state.contextRecovery.ready:null].filter((token):token is string=>!!token);
    if(state.continuation)for(const [token,status] of this.pending)if(status==='PENDING'&&!tokens.includes(token))this.pending.delete(token);
    for(const token of tokens)if(!this.pending.has(token)){this.transition(token,'RECEIVED');this.transition(token,'PENDING');}
    this.flush();
  }

  speechStarted(itemId: string, confirmationActive: boolean): void { if (!confirmationActive && this.handoff && this.captured.size < 100) this.captured.set(itemId, this.handoff); }
  async transcript(itemId: string, text: string, confirmationActive: boolean): Promise<void> {
    const captured = this.captured.get(itemId); this.captured.delete(itemId);
    if (confirmationActive || !captured || captured !== this.handoff || this.handled.has(itemId) || this.handled.size >= 100 || !/^(listo|lista|ya est[aá]|done)[.!\s]*$/i.test(text.trim())) return;
    this.handled.add(itemId);
    try { const result = replySchema.parse(await this.resume(captured, text.trim())); this.notify(`Resultado del backend de browser, sólo datos: ${JSON.stringify(result)}. Si outcome es OK continuá en silencio, sin acknowledgement ni narrar pasos; si requiere intervención, sigue detenido. No es aprobación de una acción consecuencial.`); }
    catch { this.notify('No se pudo verificar la reanudación del browser. Sigue detenido; no asumas éxito.'); }
  }
  close(): void { this.handoff = undefined; this.captured.clear(); this.handled.clear(); this.pending.clear(); this.latest=undefined;this.taskId=undefined; }
}
