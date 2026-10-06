import { z } from 'zod';
export const browserExecutionStateSchema = z.enum(['TASK_ACCEPTED','RUNNING','RECOVERING_CONTEXT','INCONCLUSIVE','WAITING_ACCESS','WAITING_CONFIRMATION','WAITING_MANUAL','COMPLETED','FAILED']);
export type BrowserExecutionState = z.infer<typeof browserExecutionStateSchema>;
export function executionState(base: BrowserExecutionState, workflow: {outcome:string} | null | undefined, confirmation: boolean, ready: boolean): BrowserExecutionState {
  if (confirmation) return 'WAITING_CONFIRMATION';
  if (workflow?.outcome === 'ACCESS_PENDING') return 'WAITING_ACCESS';
  if (workflow?.outcome === 'REQUIRES_USER_INTERACTION') return 'WAITING_MANUAL';
  if (ready && ['WAITING_ACCESS','WAITING_MANUAL'].includes(base)) return 'RUNNING';
  return base;
}
export function executionInstruction(state: BrowserExecutionState): string {
  if (state === 'TASK_ACCEPTED') return 'TASK_ACCEPTED: un único acknowledgement opcional de una frase muy breve antes de operar. No esperes a terminar el audio para ejecutar tools. Después, silencio durante RUNNING.';
  if (state === 'RECOVERING_CONTEXT') return 'RECOVERING_CONTEXT: recuperación READ interna acotada y silenciosa; no repitas acciones ejecutadas. No es fallo de tarea.';
  if (state === 'INCONCLUSIVE') return 'Browser INCONCLUSIVE: la acción fue ejecutada pero no se pudo recuperar el estado de la página. Da un resultado final breve sin afirmar que no se ejecutó.';
  if (state === 'RUNNING') return 'Browser RUNNING: continuá ejecutando en silencio, sin acknowledgement ni narrar pasos. No digas «voy a observar», «ahora busco» ni «voy a hacer click». No afirmes que terminó la tarea.';
  if (state === 'COMPLETED') return 'Browser COMPLETED: resultado final breve, distingue ejecución conocida de efectos verificados; nunca describas verification como confirmación.';
  if (state === 'FAILED') return 'Browser FAILED: explica brevemente el bloqueo real; no inventes éxito ni reintentes acciones inciertas.';
  return `Browser ${state}: podés solicitar brevemente al usuario el consentimiento, confirmación o intervención correspondiente. Site Access nunca aprueba una acción sensible.`;
}
