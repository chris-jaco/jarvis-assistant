import { OpenAIRealtimeWebRTC, RealtimeAgent, RealtimeSession } from '@openai/agents-realtime';
import { JARVIS_INSTRUCTIONS, REALTIME_MODEL } from '../core/personality.js';
import type { VoiceProvider, ProviderObserver, TranscriptEntry } from '../core/provider.js';
import { SessionMetrics } from '../telemetry/session.js';

class ClientError extends Error {}
export class OpenAIVoiceProvider implements VoiceProvider {
  private session?: RealtimeSession;
  private stream?: MediaStream;
  private abort?: AbortController;
  private generation = 0;
  private active = false;
  readonly metrics = new SessionMetrics();
  constructor(private readonly observer: ProviderObserver, private readonly audio: HTMLAudioElement) {}

  async connect(): Promise<void> {
    this.disconnect();
    const generation = ++this.generation;
    const current = () => generation === this.generation;
    this.active = true;
    this.metrics.reset();
    this.observer.transcript([]);
    this.observer.state('connecting');
    const abort = new AbortController();
    this.abort = abort;
    const timeout = setTimeout(() => {
      if (current()) this.fail('La conexión tardó demasiado. Vuelve a conectar.');
    }, 30_000);
    try {
      if (!navigator.mediaDevices?.getUserMedia || typeof RTCPeerConnection === 'undefined') {
        throw new ClientError('Este navegador necesita WebRTC y un contexto seguro (localhost o HTTPS).');
      }
      // Own the stream so cancellation always releases microphone tracks.
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      if (!current()) { stream.getTracks().forEach(track => track.stop()); return; }
      this.stream = stream;
      const response = await fetch('/api/realtime/token', { method: 'POST', signal: abort.signal });
      const data: unknown = await response.json();
      if (!response.ok) {
        const message = typeof data === 'object' && data !== null && 'error' in data && typeof data.error === 'string' ? data.error : 'No se pudo autenticar la sesión.';
        throw new ClientError(message);
      }
      if (typeof data !== 'object' || data === null || !('value' in data) || typeof data.value !== 'string' || !data.value.startsWith('ek_')) {
        throw new ClientError('No se recibió un token efímero válido.');
      }
      if (!current()) return;
      const transport = new OpenAIRealtimeWebRTC({ mediaStream: stream, audioElement: this.audio });
      const session = new RealtimeSession(new RealtimeAgent({ name: 'JARVIS', instructions: JARVIS_INSTRUCTIONS }), {
        model: REALTIME_MODEL, transport, tracingDisabled: true,
        config: { outputModalities: ['audio'], audio: {
          input: { transcription: { model: 'gpt-4o-mini-transcribe', language: 'es' },
            turnDetection: { type: 'semantic_vad', eagerness: 'medium', createResponse: true, interruptResponse: true } },
          output: { voice: 'marin' }
        } }
      });
      this.session = session;
      let speaking = false;
      session.on('error', () => { if (current()) this.fail('Error de la sesión Realtime. Revisa tu conexión y vuelve a conectar.'); });
      transport.on('connection_change', status => {
        if (current() && status === 'disconnected' && this.active) this.fail('Se perdió la conexión. Vuelve a conectar para iniciar una sesión nueva.');
      });
      session.on('transport_event', event => {
        if (!current()) return;
        switch (event.type) {
          case 'input_audio_buffer.speech_started':
            this.metrics.detectedTurns++;
            if (speaking) this.metrics.interruptions++;
            speaking = false;
            this.observer.state('listening');
            break;
          case 'input_audio_buffer.speech_stopped': this.observer.state('connected'); break;
          // Playback events reflect actual WebRTC audio buffering, not response generation.
          case 'output_audio_buffer.started': speaking = true; this.observer.state('speaking'); break;
          case 'output_audio_buffer.stopped':
          case 'output_audio_buffer.cleared': speaking = false; this.observer.state('connected'); break;
          case 'conversation.item.input_audio_transcription.failed':
            this.observer.state(speaking ? 'speaking' : 'connected', 'No se pudo transcribir este turno. Puedes seguir hablando.'); break;
        }
      });
      session.on('history_updated', history => {
        if (!current()) return;
        const entries: TranscriptEntry[] = [];
        for (const item of history) {
          if (item.type !== 'message' || (item.role !== 'user' && item.role !== 'assistant')) continue;
          const text = item.content.map(part => {
            if ('text' in part && typeof part.text === 'string') return part.text;
            if ('transcript' in part && typeof part.transcript === 'string') return part.transcript;
            return '';
          }).filter(Boolean).join('\n');
          if (text) entries.push({ id: item.itemId, role: item.role, text });
        }
        this.observer.transcript(entries);
      });
      await session.connect({ apiKey: data.value });
      if (!current()) { session.close(); return; }
      this.metrics.connected();
      this.observer.state('connected');
      // Browsers may reject autoplay; provide a user-gesture playback button in the UI.
      void this.audio.play().catch(() => {
        if (current()) this.observer.state('connected', 'Pulsa «Activar audio» si no oyes la respuesta.');
      });
    } catch (error) {
      if (!current()) return;
      const denied = error instanceof DOMException && error.name === 'NotAllowedError';
      const absent = error instanceof DOMException && error.name === 'NotFoundError';
      this.fail(denied ? 'Permiso de micrófono denegado. Actívalo en el navegador y vuelve a conectar.' : absent ? 'No se encontró un micrófono.' : error instanceof ClientError ? error.message : 'No se pudo conectar. Comprueba micrófono, red y configuración del backend.');
    } finally { clearTimeout(timeout); }
  }
  private fail(message: string): void { this.disconnect(); this.observer.state('error', message); }
  disconnect(): void {
    ++this.generation;
    this.active = false;
    this.abort?.abort();
    this.abort = undefined;
    const session = this.session;
    this.session = undefined;
    try { session?.close(); } catch {
      // Cleanup must still release capture even if the SDK transport is already closed.
    } finally {
      this.stream?.getTracks().forEach(track => track.stop());
      this.stream = undefined;
      this.audio.pause();
      this.audio.srcObject = null;
      this.observer.state('disconnected');
    }
  }
  interrupt(): void {
    try { this.session?.interrupt(); } catch { this.fail('No se pudo interrumpir la respuesta. Vuelve a conectar.'); }
  }
}
