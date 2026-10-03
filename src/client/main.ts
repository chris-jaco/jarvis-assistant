import { OpenAIVoiceProvider } from '../provider/openai.js';
import './style.css';
function element<T extends HTMLElement>(id: string): T {
  const value = document.getElementById(id);
  if (!value) throw new Error(`Missing UI element: ${id}`);
  return value as T;
}
const connect = element<HTMLButtonElement>('connect');
const disconnect = element<HTMLButtonElement>('disconnect');
const interrupt = element<HTMLButtonElement>('interrupt');
const play = element<HTMLButtonElement>('play');
const audio = element<HTMLAudioElement>('audio');
const transcript = element<HTMLOListElement>('transcript');
const provider = new OpenAIVoiceProvider({
  state(next, message) {
    element('state').textContent = next;
    element('message').textContent = message ?? ({
      disconnected: 'Conecta y permite el acceso al micrófono.', connecting: 'Conectando…',
      connected: 'Micrófono activo. Puedes hablar.', listening: 'Escuchando…', speaking: 'JARVIS está hablando.', error: 'No se pudo mantener la sesión.'
    })[next];
    const active = next === 'connected' || next === 'listening' || next === 'speaking';
    connect.disabled = active || next === 'connecting';
    disconnect.disabled = !active && next !== 'connecting';
    interrupt.disabled = !active;
    play.disabled = !active;
    renderMetrics();
  },
  transcript(entries) {
    transcript.replaceChildren(...entries.map(entry => {
      const row = document.createElement('li');
      const label = document.createElement('strong');
      label.textContent = entry.role === 'user' ? 'Tú: ' : 'JARVIS: ';
      row.append(label, document.createTextNode(entry.text));
      return row;
    }));
  }
}, audio);
function renderMetrics(): void {
  const { connectionMs, detectedTurns, interruptions } = provider.metrics;
  element('metrics').textContent = `Conexión: ${connectionMs === null ? '—' : `${connectionMs} ms`} · Turnos detectados: ${detectedTurns} · Interrupciones por voz detectadas: ${interruptions}`;
}
connect.addEventListener('click', () => { void provider.connect(); });
disconnect.addEventListener('click', () => provider.disconnect());
interrupt.addEventListener('click', () => provider.interrupt());
play.addEventListener('click', () => {
  void audio.play().catch(() => { element('message').textContent = 'El navegador bloqueó el audio. Revisa los permisos de reproducción.'; });
});
window.addEventListener('pagehide', () => provider.disconnect());
renderMetrics();
