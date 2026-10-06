import { z } from 'zod';
export const browserExecutionStateSchema = z.enum(['RUNNING','WAITING_ACCESS','WAITING_CONFIRMATION','WAITING_MANUAL','COMPLETED','FAILED']);
export type BrowserExecutionState = z.infer<typeof browserExecutionStateSchema>;
export function executionState(base: BrowserExecutionState, workflow: {outcome:string} | null | undefined, confirmation: boolean, ready: boolean): BrowserExecutionState {
  if (confirmation) return 'WAITING_CONFIRMATION';
  if (workflow?.outcome === 'ACCESS_PENDING') return 'WAITING_ACCESS';
  if (workflow?.outcome === 'REQUIRES_USER_INTERACTION') return 'WAITING_MANUAL';
  if (ready && ['WAITING_ACCESS','WAITING_MANUAL'].includes(base)) return 'RUNNING';
  return base;
}
export function executionInstruction(state: BrowserExecutionState): string {
  if (state === 'RUNNING') return 'Browser RUNNING: continuá ejecutando en silencio, sin acknowledgement ni narrar pasos. No digas «voy a observar», «ahora busco» ni «voy a hacer click». No afirmes que terminó la tarea.';
  if (state === 'COMPLETED') return 'Browser COMPLETED: resultado final breve, sólo con hechos verificados.';
  if (state === 'FAILED') return 'Browser FAILED: explica brevemente el bloqueo real; no inventes éxito ni reintentes acciones inciertas.';
  return `Browser ${state}: podés solicitar brevemente al usuario el consentimiento, confirmación o intervención correspondiente. Site Access nunca aprueba una acción sensible.`;
}
