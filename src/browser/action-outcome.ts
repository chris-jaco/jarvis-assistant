import { z } from 'zod';
import type { AttachedObservation, ObservationResult } from './attached/protocol.js';
export const actionOutcomeSchema = z.object({
  actionId: z.string().uuid(),
  outcome: z.enum(['ACTION_FAILED','ACTION_EXECUTED_UNVERIFIED','ACTION_VERIFIED','EXECUTION_UNKNOWN']),
  execution: z.enum(['NOT_EXECUTED','EXECUTED','UNKNOWN']),
  verification: z.enum(['NOT_APPLICABLE','PENDING','INCONCLUSIVE','FAILED','VERIFIED']),
  evidence: z.enum(['PLAYBACK_PLAYING','PAUSED','TARGET_LOCATION']).optional()
}).strict().refine(value=>value.outcome==='ACTION_FAILED'?value.execution==='NOT_EXECUTED'&&value.verification==='NOT_APPLICABLE':value.outcome==='EXECUTION_UNKNOWN'?value.execution==='UNKNOWN':value.execution==='EXECUTED'&&(value.outcome==='ACTION_VERIFIED'?value.verification==='VERIFIED'&&!!value.evidence:value.verification!=='VERIFIED'));
export type ActionOutcome = z.infer<typeof actionOutcomeSchema>;
export type ExpectedEffect = { kind:'play'|'pause';tabId?:string;scopeId?:string;documentId?:string } | {kind:'navigation';target:string};
export class ActionRecord {
  readonly actionId = crypto.randomUUID();
  private execution: ActionOutcome['execution'] = 'NOT_EXECUTED';
  private verification: ActionOutcome['verification'] = 'NOT_APPLICABLE';
  private evidence?: ActionOutcome['evidence'];
  private reads = 0;
  constructor(private readonly expected?: ExpectedEffect) {}
  executed(): void { this.execution='EXECUTED';this.verification='PENDING'; }
  unknown(): void { if(this.execution!=='EXECUTED'){this.execution='UNKNOWN';this.verification='INCONCLUSIVE';} }
  observe(result: ObservationResult): void {
    if(this.execution!=='EXECUTED')return;
    if(result.status==='FAILED'){if(this.verification!=='VERIFIED')this.verification='FAILED';return;}
    const evidence=this.match(result.data);
    if(evidence){this.verification='VERIFIED';this.evidence=evidence;}
    else if(this.verification!=='VERIFIED')this.verification='INCONCLUSIVE';
  }
  private match(data:AttachedObservation):ActionOutcome['evidence'] {
    if(this.expected&&this.expected.kind!=='navigation'&&((this.expected.tabId&&data.tabId!==this.expected.tabId)||(this.expected.scopeId&&data.scopeId!==this.expected.scopeId)||(this.expected.documentId&&data.documentId!==this.expected.documentId)))return;
    if(this.expected?.kind==='play'&&data.media?.presence==='AVAILABLE'&&data.media.playback==='PLAYING')return 'PLAYBACK_PLAYING'; // Verifies playback only, never the identity of content or absence of ads.
    if(this.expected?.kind==='pause'&&data.media?.presence==='AVAILABLE'&&data.media.playback==='PAUSED')return 'PAUSED';
    if(this.expected?.kind==='navigation'){try{const target=new URL(this.expected.target),actual=new URL(data.url);if(!target.search&&!target.hash&&actual.origin===target.origin&&actual.pathname===target.pathname)return 'TARGET_LOCATION';}catch{}}
    return;
  }
  claimRead():boolean { return this.execution==='EXECUTED'&&this.verification!=='VERIFIED'&&this.reads++<2; }
  result():ActionOutcome {return {actionId:this.actionId,execution:this.execution,verification:this.verification,outcome:this.execution==='UNKNOWN'?'EXECUTION_UNKNOWN':this.execution==='NOT_EXECUTED'?'ACTION_FAILED':this.verification==='VERIFIED'?'ACTION_VERIFIED':'ACTION_EXECUTED_UNVERIFIED',...(this.evidence?{evidence:this.evidence}:{})};}
}
export function outcomeInstruction(outcome:ActionOutcome):string {
  if(outcome.execution==='EXECUTED'&&outcome.outcome==='ACTION_EXECUTED_UNVERIFIED')return 'La acción fue ejecutada/aceptada, pero su efecto no está verificado. Nunca digas «No pude hacerlo». Si terminás: «Ejecuté la acción, pero no pude comprobar el resultado». Sólo verificación READ acotada, nunca repetir la acción.';
  if(outcome.outcome==='EXECUTION_UNKNOWN')return 'Ejecución desconocida: no asumas éxito o fracaso, no retry ni otra vía de ejecutar la misma acción.';
  if(outcome.outcome==='ACTION_VERIFIED')return 'Efecto verificado mediante evidencia observable. Esto NO termina automáticamente la tarea.';
  return 'Esta acción no se ejecutó. No confundas este resultado con una acción anterior ejecutada.';
}
