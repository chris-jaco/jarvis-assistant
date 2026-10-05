import type { ConnectionState } from '../core/provider.js';
export const stateLabels: Record<ConnectionState, string> = { disconnected: 'Desconectado', connecting: 'Conectando', connected: 'Conectado', listening: 'Escuchando', thinking: 'Pensando', speaking: 'Hablando', error: 'Sin conexión' };
// Projection of existing provider/telemetry signals, not conversation authority.
export function presentationState(state: ConnectionState, toolRunning: boolean): ConnectionState { return state === 'connected' && toolRunning ? 'thinking' : state; }
export function orbEnergy(state: ConnectionState, microphone: number, playback: number): number {
  const value = state === 'listening' ? microphone : state === 'speaking' ? playback : 0;
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}
export class AtlasOrb {
  private state: ConnectionState = 'disconnected';
  constructor(private readonly element: HTMLElement, private readonly reducedMotion: MediaQueryList) {
    reducedMotion.addEventListener('change', this.motion); this.motion(); this.update('disconnected');
  }
  private motion = () => { this.element.dataset.reducedMotion = String(this.reducedMotion.matches); };
  update(state: ConnectionState): void { if (this.state !== state || !this.element.dataset.state) this.element.style.setProperty('--energy', '0'); this.state = state; this.element.dataset.state = state; }
  levels(microphone: number, playback: number): void { this.element.style.setProperty('--energy', orbEnergy(this.state, microphone, playback).toFixed(3)); }
  dispose(): void { this.reducedMotion.removeEventListener('change', this.motion); this.element.style.setProperty('--energy', '0'); }
}
