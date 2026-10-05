import { OpenAIVoiceProvider } from '../provider/openai.js';
import type { ConnectionState } from '../core/provider.js';
import { AtlasOrb, stateLabels, presentationState } from './orb.js';
import { AudioLevels } from './audio-levels.js';
import { Transcript } from './transcript.js';
import { ConfirmationDialog } from './confirmation-dialog.js';
import './style.css';
function element<T extends HTMLElement>(id: string): T { const value = document.getElementById(id); if (!value) throw new Error(`Missing UI element: ${id}`); return value as T; }
const toggle = element<HTMLButtonElement>('session-toggle'); const interrupt = element<HTMLButtonElement>('interrupt'); const play = element<HTMLButtonElement>('play');
const audio = element<HTMLAudioElement>('audio');
const orb = new AtlasOrb(element('atlas-orb'), matchMedia('(prefers-reduced-motion: reduce)'));
const levels = new AudioLevels(audio, (input, output) => orb.levels(input, output));
const transcript = new Transcript(element('transcript'), element('transcript-scroll'));
const confirmation = new ConfirmationDialog(element<HTMLDialogElement>('confirmation-dialog'), element('tool-confirmation'), element('confirmation-status'), element<HTMLButtonElement>('tool-approve'), element<HTMLButtonElement>('tool-reject'), (approved, id) => provider.confirmTool(approved, id));
let state: ConnectionState = 'disconnected'; let toolRunning = false; let statusMessage: string | undefined;
function renderState(): void {
  const visual = presentationState(state, toolRunning); orb.update(visual); document.body.dataset.state = visual;
  element('state').textContent = stateLabels[visual];
  element('message').textContent = statusMessage ?? ({ disconnected: 'Tocá el orb para conversar.', connecting: 'Preparando la conversación…', connected: 'Podés hablar cuando quieras.', listening: 'Te escucho.', thinking: '', speaking: 'Podés interrumpirme hablando.', error: 'Tocá el orb para volver a conectar.' })[visual];
}
const provider = new OpenAIVoiceProvider({
  state(next, message) {
    state = next; statusMessage = message; renderState();
    toggle.setAttribute('aria-label', next === 'disconnected' || next === 'error' ? 'Conectar con Atlas' : 'Desconectar de Atlas');
    interrupt.hidden = next !== 'speaking'; if (next === 'disconnected' || next === 'connecting' || next === 'error') play.hidden = true; else if (message?.includes('Activar audio')) play.hidden = false; renderMetrics();
  },
  microphone(stream) { if (stream) levels.start(stream); else levels.stop(); },
  tools(rows, pending) {
    element('tool-activity').replaceChildren(...rows.slice(-8).map(row => { const item = document.createElement('li'); item.textContent = `${row.toolId} · ${row.status === 'pending' ? 'esperando confirmación' : row.status === 'success' ? '✓' : row.status} ${row.durationMs === undefined ? '' : `${row.durationMs} ms total${row.executionMs === undefined ? '' : ` · ejecución ${row.executionMs} ms`}${row.confirmationWaitMs === undefined ? '' : ` · espera ${row.confirmationWaitMs} ms`}`}${row.errorCategory ? ` · ${row.errorCategory}` : ''}`; return item; }));
    toolRunning = rows.some(row => row.status === 'running'); renderState(); confirmation.update(pending);
  },
  transcript(entries) { transcript.update(entries); }
}, audio);
function renderMetrics(): void { const { connectionMs, detectedTurns, interruptions } = provider.metrics; element('metrics').textContent = `Conexión: ${connectionMs === null ? '—' : `${connectionMs} ms`} · Turnos: ${detectedTurns} · Interrupciones: ${interruptions}`; }
toggle.addEventListener('click', () => { if (state === 'disconnected' || state === 'error') { void provider.connect(); if ((state as ConnectionState) === 'connecting') levels.prepare(); } else provider.disconnect(); });
interrupt.addEventListener('click', () => provider.interrupt());
play.addEventListener('click', () => { levels.resume(); void audio.play().then(() => { play.hidden = true; }).catch(() => { element('message').textContent = 'Revisá los permisos de reproducción del navegador.'; }); });
window.addEventListener('pagehide', () => { provider.disconnect(); levels.stop(); confirmation.dispose(); orb.dispose(); });
// pagehide may place the page in the back/forward cache. Reload only when restored,
// so disposed listeners cannot leave a revived page with a partially active UI.
window.addEventListener('pageshow', event => { if (event.persisted) window.location.reload(); });
renderMetrics();
