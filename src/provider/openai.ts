import { BrowserTaskDiagnostics } from '../diagnostics/browser-task.js';
import { PresentationGate } from './presentation-gate.js';
import { OpenAIRealtimeWebRTC, RealtimeAgent, RealtimeSession } from '@openai/agents-realtime';
import { ASSISTANT_NAME, JARVIS_INSTRUCTIONS, REALTIME_MODEL, JARVIS_VOICE, TURN_EAGERNESS } from '../core/personality.js';
import type { VoiceProvider, ProviderObserver, TranscriptEntry } from '../core/provider.js';
import { VoiceMemoryBridge, updateMemoryInstructions } from './memory.js';
import { VoiceToolBridge } from './tools.js';
import { SessionMetrics } from '../telemetry/session.js';

class ClientError extends Error {}
export class OpenAIVoiceProvider implements VoiceProvider {
  private presentation?:PresentationGate;
  private session?: RealtimeSession;
  private tools?: VoiceToolBridge;
  private memory?: VoiceMemoryBridge;
  private stream?: MediaStream;
  private visualState: import('../core/provider.js').ConnectionState = 'disconnected';
  private state(state: import('../core/provider.js').ConnectionState, message?: string): void { this.visualState = state; this.observer.state(state, message); }
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
    this.state('connecting');
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
      this.observer.microphone?.(stream);
      const response = await fetch('/api/realtime/token', { method: 'POST', signal: abort.signal });
      const data: unknown = await response.json();
      if (!response.ok) {
        const message = typeof data === 'object' && data !== null && 'error' in data && typeof data.error === 'string' ? data.error : 'No se pudo autenticar la sesión.';
        throw new ClientError(message);
      }
      if (typeof data !== 'object' || data === null || !('value' in data) || typeof data.value !== 'string' || !data.value.startsWith('ek_')) {
        throw new ClientError('No se pudo autorizar esta conversación.');
      }
      if (!current()) return;
      const playbackDiagnostics=new BrowserTaskDiagnostics();
      const gate=new PresentationGate(muted=>{this.audio.muted=muted;},playbackDiagnostics,()=>({visibility:document.visibilityState,paused:this.audio.paused,ended:this.audio.ended}));this.presentation=gate;
      const bridge = new VoiceToolBridge((rows, pending) => { if (current()) this.observer.tools?.(rows, pending); }, message => { if (current()&&this.session){const id=crypto.randomUUID();gate.internal(id);transport.sendMessage(message,{item:{id,type:'message',role:'user',content:[{type:'input_text',text:message}]}},{triggerResponse:false});transport.requestResponse({metadata:{atlas_presentation_source:'INTERNAL_BROWSER_CONTINUATION'}});} },undefined,undefined,{state:state=>gate.update(state),tool:browser=>{gate.tool();if(browser)gate.beginBrowser();}});
      this.tools = bridge;
      const toolConfig = await bridge.initialize();
      playbackDiagnostics.enabled=bridge.browserTraceEnabled;
      if (!current()) { bridge.close(); return; }
      const transport = new OpenAIRealtimeWebRTC({ mediaStream: stream, audioElement: this.audio });
      const baseInstructions = `${JARVIS_INSTRUCTIONS}\n${toolConfig.context}`;
      let memoryContext = '';
      const memory = new VoiceMemoryBridge(async context => {
        if (current() && this.session) { memoryContext = context; updateMemoryInstructions(transport, `${baseInstructions}\n${memoryContext}`); }
      }, () => bridge.confirmationActive);
      this.memory = memory;
      memoryContext = await memory.initial();
      if (!current()) { memory.close(); return; }
      const session = new RealtimeSession(new RealtimeAgent({ name: ASSISTANT_NAME, instructions: () => `${baseInstructions}\n${memoryContext}`, tools: toolConfig.tools }), {
        model: REALTIME_MODEL, transport, tracingDisabled: true,
        config: { outputModalities: ['audio'], audio: {
          input: { transcription: { model: 'gpt-4o-mini-transcribe', language: 'es' },
            turnDetection: { type: 'semantic_vad', eagerness: TURN_EAGERNESS, createResponse: true, interruptResponse: true } },
          output: { voice: JARVIS_VOICE }
        } }
      });
      this.session = session;
      session.on('agent_tool_end', (_context,_agent,_tool,result,details) => {if(current()&&'callId' in details.toolCall)bridge.toolOutputCommitted(details.toolCall.callId,result);});
      let speaking = false;
      session.on('error', () => { if (current()) this.fail('Se interrumpió la conversación. Revisá tu conexión y volvé a conectar.'); });
      transport.on('connection_change', status => {
        if (current() && status === 'disconnected' && this.active) this.fail('Se perdió la conexión. Vuelve a conectar para iniciar una sesión nueva.');
      });
      session.on('transport_event', event => {
        if (!current()) return;
        const raw=event as unknown as {response_id?:unknown;response?:unknown};
        const response=raw.response as {id?:string;metadata?:Record<string,unknown>;output?:{type?:string;id?:string}[]}|undefined;
        const responseId=typeof raw.response_id==='string'?raw.response_id:response?.id;
        if(event.type==='response.created'&&responseId)gate.response(responseId,response?.metadata?.atlas_presentation_source==='INTERNAL_BROWSER_CONTINUATION');
        if(event.type==='response.output_item.added'&&responseId){const item=event.item as {id?:string;type?:string}|undefined;if(item?.id)gate.item(responseId,item.id,item.type);if(item?.type==='function_call')gate.tool(responseId);}
        if(event.type==='input_audio_buffer.speech_started')gate.turn(bridge.confirmationActive);
        if(event.type==='output_audio_buffer.started')gate.playback(responseId);
        if(event.type==='output_audio_buffer.started')gate.playbackEvent('STARTED',responseId);
        if(event.type==='output_audio_buffer.stopped')gate.playbackEvent('STOPPED',responseId);
        if(event.type==='output_audio_buffer.cleared')gate.playbackEvent('CLEARED',responseId);
        if(event.type==='response.done'&&responseId)gate.done(responseId);
        void bridge.transportEvent(event).catch(() => undefined);
        if (event.type === 'input_audio_buffer.speech_started' && typeof event.item_id === 'string') memory.speechStarted(event.item_id);
        if (event.type === 'conversation.item.input_audio_transcription.completed' && typeof event.item_id === 'string' && typeof event.transcript === 'string') {
          void memory.turn(event.item_id, event.transcript);
        }
        switch (event.type) {
          case 'input_audio_buffer.speech_started':
            this.metrics.detectedTurns++;
            if (speaking) this.metrics.interruptions++;
            speaking = false;
            this.state('listening');
            break;
          case 'input_audio_buffer.speech_stopped': this.state('thinking'); break;
          case 'response.created': if (!speaking && this.visualState !== 'listening') this.state('thinking'); break;
          case 'response.done': if (!speaking && this.visualState === 'thinking') this.state('connected'); break;
          // Playback events reflect actual WebRTC audio buffering, not response generation.
          case 'output_audio_buffer.started': speaking = gate.audible(responseId); if(speaking)this.state('speaking');else if(this.visualState!=='listening')this.state('thinking');break;
          case 'output_audio_buffer.stopped':
          case 'output_audio_buffer.cleared':
            speaking = false; if (this.visualState !== 'listening') this.state('connected'); break;
          case 'conversation.item.input_audio_transcription.failed':
            this.state(speaking ? 'speaking' : 'connected', 'No se pudo transcribir este turno. Puedes seguir hablando.'); break;
        }
      });
      session.on('history_updated', history => {
        if (!current()) return;
        const entries: TranscriptEntry[] = [];
        for (const item of history) {
          if (item.type !== 'message' || (item.role !== 'user' && item.role !== 'assistant') ||item.role==='user'&&!gate.userVisible(item.itemId)|| item.role==='assistant'&&!gate.visible(item.itemId)) continue;
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
      this.state('connected');
      // Browsers may reject autoplay; provide a user-gesture playback button in the UI.
      void this.audio.play().catch(() => {
        if (current()) this.state('connected', 'Pulsa «Activar audio» si no oyes la respuesta.');
      });
    } catch (error) {
      if (!current()) return;
      const denied = error instanceof DOMException && error.name === 'NotAllowedError';
      const absent = error instanceof DOMException && error.name === 'NotFoundError';
      this.fail(denied ? 'Permiso de micrófono denegado. Actívalo en el navegador y vuelve a conectar.' : absent ? 'No se encontró un micrófono.' : error instanceof ClientError ? error.message : 'No se pudo conectar. Comprueba micrófono, red y configuración del backend.');
    } finally { clearTimeout(timeout); }
  }
  private fail(message: string): void { this.disconnect(); this.state('error', message); }
  disconnect(): void {
    ++this.generation;
    this.active = false;
    this.presentation?.close();this.presentation=undefined;
    this.memory?.close(); this.memory = undefined;
    this.tools?.close(); this.tools = undefined;
    this.observer.tools?.([], null);
    this.abort?.abort();
    this.abort = undefined;
    const session = this.session;
    this.session = undefined;
    try { session?.close(); } catch {
      // Cleanup must still release capture even if the SDK transport is already closed.
    } finally {
      this.observer.microphone?.(null);
      this.stream?.getTracks().forEach(track => track.stop());
      this.stream = undefined;
      this.audio.pause();
      this.audio.srcObject = null;
      this.state('disconnected');
    }
  }
  confirmTool(approved: boolean, confirmationId: string): void {
    if (this.tools?.pending?.confirmationId === confirmationId) void this.tools.decide(approved);
  }
  interrupt(): void {
    try { this.session?.interrupt(); } catch { this.fail('No se pudo interrumpir la respuesta. Vuelve a conectar.'); }
  }
}
