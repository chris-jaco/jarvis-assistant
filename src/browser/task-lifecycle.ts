import { z } from 'zod';
export const endTaskSchema = z.object({ reason:z.enum(['COMPLETED','CANCELLED','TERMINAL','INCONCLUSIVE']).optional(), evidence:z.object({actionId:z.string().uuid()}).strict().optional() }).strict();
export type EndTaskRequest = z.infer<typeof endTaskSchema>;
export const continuationReceiptSchema = z.object({taskId:z.string().uuid(),tokens:z.array(z.string().uuid()).max(3)}).strict();
export type ContinuationReceipt = z.infer<typeof continuationReceiptSchema>;
export interface TaskFacts {
  intent?:'READ_ONLY'|'ACTION_REQUIRED'; readObtained?:boolean;
  progress:boolean; pending:boolean; unknown:boolean; fresh:boolean;
  verificationRequired:boolean; verified:boolean; verificationExhausted:boolean;
  cancelled:boolean; terminal:boolean; recoveryExhausted:boolean;
}
// Structural evidence only. This does not infer satisfaction of a user's semantic objective.
export function canEndTask(request:EndTaskRequest, facts:TaskFacts):boolean {
  switch(request.reason){
    case 'COMPLETED': return (facts.intent==='READ_ONLY' ? facts.readObtained===true : facts.progress) && !facts.pending && !facts.unknown && facts.fresh && (!facts.verificationRequired || facts.verified);
    case 'CANCELLED': return facts.cancelled;
    case 'TERMINAL': return facts.terminal;
    case 'INCONCLUSIVE': return !facts.unknown && !facts.pending && (facts.recoveryExhausted || facts.verificationExhausted);
    default:return false;
  }
}
export function explicitBrowserCancellation(text:string):boolean {
  return /^(?:atlas[, ]+)?(?:cancel[aá]|cancelar|deten[eé]|cancel) (?:la )?(?:tarea (?:del |de )?navegador|tarea browser|browser task)[.!\s]*$/i.test(text.trim());
}
