import { BrowserTaskAdmission } from './browser-task-admission.js';
import { continuationReceiptSchema, explicitBrowserCancellation } from '../browser/task-lifecycle.js';
import { BrowserTaskDiagnostics } from '../diagnostics/browser-task.js';
import { PopupDiagnostics } from '../diagnostics/popup.js';
import { actionOutcomeSchema, outcomeInstruction } from '../browser/action-outcome.js';
import type { BrowserExecutionState } from '../browser/execution-state.js';
import { browserExecutionStateSchema, executionInstruction } from '../browser/execution-state.js';
import { BrowserContinuation } from './browser-continuation.js';
import { browserTracer, browserCode, isBrowserTool } from '../diagnostics/browser.js';
import type { BrowserDiagnosticSink } from '../diagnostics/browser.js';
import { tool, setSensitiveDataLoggingEnabled } from '@openai/agents-realtime';
import { z } from 'zod';
import { confirmationTracer } from '../diagnostics/confirmation.js';
import type { ConfirmationTrace, TraceSink } from '../diagnostics/confirmation.js';
import { intentSchema } from '../tools/confirmation-intent.js';
import type { ToolResult } from '../tools/types.js';
import type { ToolActivity } from '../tools/telemetry.js';
setSensitiveDataLoggingEnabled(false);
export interface PendingConfirmation { confirmationId: string; summary: string; expiresAt: number }
interface Descriptor { permission?:'READ'|'WRITE'|'SENSITIVE'; id: string; description: string; inputSchema: unknown }
export async function toolRequest(path: string, data?: unknown, method = 'POST', browserRequest?: { sequence: number; response(call: string): void }): Promise<unknown> {
  const response = await fetch(`/api/tools/${path}`, { method, headers: { 'Content-Type': 'application/json', ...(browserRequest ? { 'X-Atlas-Browser-Request': String(browserRequest.sequence) } : {}) },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }), signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error('No se pudo contactar con las herramientas. Reconecta si la sesión caducó.');
  const call = response.headers.get('X-Atlas-Browser-Call');
  if (browserRequest && call && /^b[1-9]\d{0,8}$/.test(call)) browserRequest.response(call);
  return response.json();
}
export class VoiceToolBridge {
  get browserTraceEnabled():boolean {return this.taskDiagnostics.enabled;}
  pending: PendingConfirmation | null = null;
  get confirmationActive(): boolean { return Boolean(this.pending || this.decisionInFlight || this.intentInFlight); }
  private readonly taskDiagnostics=new BrowserTaskDiagnostics();
  private responseTrace=new Map<string,{producedMessage:boolean;producedFunctionCall:boolean;tokens:string[]}>();
  private requestedTraceTokens:string[]=[];
  private traceSchedule(){return {toolInFlight:this.browserInvocations>0||this.sdkPending.size>0,sdkAwaitingResponse:this.sdkAwaitingResponse,sdkPendingCalls:this.sdkPending.size,sdkAnnouncedCalls:this.sdkAnnounced.size,sdkActiveResponses:this.sdkResponses.size,activeInvocations:this.browserInvocations};}
  private sdkPending=new Set<string>();
  private sdkToolNames=new Set<string>();private sdkCommitted=new Set<string>();
  private sdkAnnounced=new Set<string>();private sdkResponses=new Set<string>();private sdkAwaitingResponse=false;
  private browserBusy():boolean {return this.browserInvocations>0||this.sdkPending.size>0||this.sdkAnnounced.size>0||this.sdkAwaitingResponse||this.sdkResponses.size>0;}
  private receiptAcks:Promise<unknown>=Promise.resolve();
  toolOutputCommitted(callId:string,raw:string):void {
    const owned=this.sdkPending.delete(callId)||this.sdkAnnounced.has(callId);this.sdkAnnounced.delete(callId);if(!owned||this.closed)return;
    // SDK already requested its next response. Hold newly arriving events until
    // that decision finishes or its own tool output incorporates them.
    this.sdkCommitted.add(callId);while(this.sdkCommitted.size>256)this.sdkCommitted.delete(this.sdkCommitted.values().next().value!);
    this.sdkAwaitingResponse=true;
    let output:unknown;try{output=JSON.parse(raw);}catch{output=undefined;}
    const receipt=output&&typeof output==='object'?(output as {browserContinuation?:unknown}).browserContinuation:undefined;
    const parsedReceipt=continuationReceiptSchema.safeParse(receipt);this.requestedTraceTokens=parsedReceipt.success?parsedReceipt.data.tokens:[];
    this.taskDiagnostics.event({stage:'RESPONSE_REQUESTED',relation:'REQUEST',...this.browserContinuation.traceContext(),source:'SDK_OUTPUT',...(/^call_[A-Za-z0-9_-]{1,100}$/.test(callId)?{callId}:{}),tokens:this.requestedTraceTokens,...this.traceSchedule()});
    this.browserContinuation.committed(receipt,this.browserBusy());
    this.taskDiagnostics.event({stage:'TOOL_COMMITTED',...this.browserContinuation.traceContext(),...(/^call_[A-Za-z0-9_-]{1,100}$/.test(callId)?{callId}:{}),toolInFlight:this.browserInvocations>0});
  }
  private traceResponse(event:{type:string;[key:string]:unknown}):void {
    if(!this.taskDiagnostics.enabled)return;
    const response=event.response as {id?:string;status?:string;output?:{type?:string}[]}|undefined;const id=typeof event.response_id==='string'?event.response_id:response?.id;
    if(!id||!/^resp_[A-Za-z0-9_-]{1,100}$/.test(id))return;
    if(event.type==='response.created'){this.responseTrace.set(id,{producedMessage:false,producedFunctionCall:false,tokens:this.requestedTraceTokens});this.requestedTraceTokens=[];while(this.responseTrace.size>256)this.responseTrace.delete(this.responseTrace.keys().next().value!);}
    const row=this.responseTrace.get(id);
    if(event.type==='response.output_item.added'&&row){const item=event.item as {type?:string}|undefined;row.producedMessage ||= item?.type==='message';row.producedFunctionCall ||= item?.type==='function_call';}
    if(event.type==='response.done'&&row){row.producedMessage ||= response?.output?.some(item=>item.type==='message')===true;row.producedFunctionCall ||= response?.output?.some(item=>item.type==='function_call')===true;}
    if(['response.done','response.output_item.added'].includes(event.type))this.taskDiagnostics.event({stage:event.type==='response.done'?'RESPONSE_DONE':'RESPONSE_OUTPUT',relation:'NEXT_RESPONSE_CANDIDATE',...this.browserContinuation.traceContext(),responseId:id,...this.traceSchedule(),tokens:row?.tokens??[],producedMessage:row?.producedMessage??false,producedFunctionCall:row?.producedFunctionCall??false,...(event.type==='response.done'?{status:['completed','cancelled','failed','incomplete','in_progress'].includes(response?.status??'')?response?.status:'UNKNOWN'}:{})});
  }
  private lifecycleEnabled=false;private admission=new BrowserTaskAdmission();private admissionInFlight?:Promise<void>;private lastBrowserState?:BrowserExecutionState;
  private presentationRevision=0;private browserInvocations=0;
  private present(raw:unknown):void {const parsed=z.object({executionState:browserExecutionStateSchema,revision:z.number().int().positive().optional(),taskActive:z.boolean().optional()}).passthrough().safeParse(raw);if(!parsed.success)return;const state=parsed.data;if(state.revision!==undefined){if(state.revision<=this.presentationRevision)return;this.presentationRevision=state.revision;}if(state.taskActive!==false||state.executionState==='WAITING_CONFIRMATION')this.presentation?.state(state.executionState);this.lastBrowserState=state.executionState;}
  private armed = false;
  private decisionInFlight = false;
  private intentRevision = 0;
  private intentInFlight = 0;
  private promptPlayback?: { confirmationId: string; responseId: string; interrupted: boolean };
  private observedResponses = new Set<string>();
  private browserUserTurns=new Set<string>();
  private captured = new Map<string, { id: string; approvable: boolean }>();
  private closed = false;
  private polling?: ReturnType<typeof setInterval>;
  private trace: TraceSink = () => {};
  private browserTrace: BrowserDiagnosticSink = () => {};
  private browserSequence = 0;
  private readonly accessDiagnostics=new PopupDiagnostics();
  private browserContinuation = new BrowserContinuation((handoffId, utterance) => toolRequest('browser-resume', { handoffId, utterance }), message => { if (!this.closed) {this.requestedTraceTokens=this.browserContinuation.deliveryTokens();this.taskDiagnostics.event({stage:'RESPONSE_REQUESTED',relation:'REQUEST',...this.browserContinuation.traceContext(),source:'NOTIFICATION',tokens:this.requestedTraceTokens,...this.traceSchedule()});this.notify(message);} },this.accessDiagnostics,this.taskDiagnostics,receipt=>{this.receiptAcks=this.receiptAcks.catch(()=>{}).then(()=>toolRequest('browser-continuation',receipt)).catch(()=>{});},()=>this.traceSchedule());
  private diagnostic(event: string, reason: string, extra: Partial<ConfirmationTrace> = {}): void {
    this.trace({ event, reason, pendingId: this.pending?.confirmationId, armed: this.armed, promptResponseId: this.promptPlayback?.responseId, ...extra });
  }
  constructor(private readonly activity: (rows: ToolActivity[], pending: PendingConfirmation | null) => void,
    private readonly notify: (message: string) => void, private readonly traceSink?: TraceSink, private readonly browserSink?: BrowserDiagnosticSink, private readonly presentation?: {state(state:BrowserExecutionState):void;tool(browser:boolean):void}) {}
  async initialize() {
    const config = await toolRequest('session', {}) as { tools: Descriptor[]; timezone: string; now: string; confirmationTrace?: boolean; browserTrace?: boolean; accessTrace?:boolean;browserPresentation?:boolean;browserTaskLifecycle?:boolean };
    this.lifecycleEnabled=config.browserTaskLifecycle===true;if(this.lifecycleEnabled)this.admission.begin();
    this.sdkToolNames=new Set(config.tools.filter(tool=>tool.id.startsWith('browser.')).map(tool=>tool.id.replaceAll('.','_')));
    this.taskDiagnostics.enabled=config.browserTrace===true;
    this.accessDiagnostics.enabled=config.accessTrace===true;
    this.browserTrace = browserTracer(config.browserTrace === true, this.browserSink);
    this.trace = confirmationTracer(config.confirmationTrace === true, this.traceSink);
    this.diagnostic('bridge.initialize', 'trace_enabled');
    if (this.closed) { void toolRequest('session', undefined, 'DELETE').catch(() => undefined); return { tools: [], context: '' }; }
    this.polling = setInterval(() => { void this.refresh(); }, 1000);
    return { context: `Zona horaria del usuario: ${config.timezone}. Fecha/hora al conectar: ${config.now}. Usa el reloj de la sesión para resolver fechas relativas.`,
      tools: config.tools.map(descriptor => tool({ name: descriptor.id.replaceAll('.', '_'),
        description: `${descriptor.description}\nEsquema del objeto JSON que debes enviar en inputJson: ${JSON.stringify(descriptor.inputSchema)}`,
        parameters: z.object({ inputJson: z.string() }), timeoutMs: 30_000,
        execute: async ({ inputJson }, _context, details) => {
          if (this.closed) return { status: 'error', message: 'Sesión cerrada.' };

          // Realtime may request another tool before asynchronous user transcription.
          // Never let the model replace/execute a frozen action while it awaits a decision.
          if (this.decisionInFlight || this.intentInFlight) { this.diagnostic('tool.invoke', this.intentInFlight ? 'blocked_while_classifying' : 'blocked_while_deciding'); return { status: 'awaiting_execution', message: 'La decisión está en procesamiento. Espera el resultado del backend; todavía no hay éxito confirmado. No repitas la acción.' }; }
          if (this.pending) { this.diagnostic('tool.invoke', 'blocked_while_pending'); return { status: 'pending', ...this.pending }; }
          let input: unknown; try { input = JSON.parse(inputJson); } catch { return { status: 'error', message: 'JSON inválido.' }; }
          this.presentation?.tool(descriptor.id.startsWith('browser.')&&config.browserPresentation!==false);
          const sdkCall=descriptor.id.startsWith('browser.')?details?.toolCall?.callId:undefined;
          if(descriptor.id.startsWith('browser.')){if(sdkCall){this.sdkPending.add(sdkCall);this.sdkAnnounced.delete(sdkCall);}++this.browserInvocations;}
          const sequence = ++this.browserSequence; const browserTool = config.browserTrace === true && isBrowserTool(descriptor.id) ? descriptor.id : undefined;
          const browserStarted = performance.now(); let browserCall: string | undefined;
          if (browserTool) this.browserTrace({ stage: 'realtime_received', code: 'RUNNING', elapsedMs: 0, clientRequest: sequence, tool: browserTool });
          const browserResult = (code: import('../diagnostics/browser.js').BrowserCode) => { if (browserTool) this.browserTrace({ stage: 'realtime_result', code, elapsedMs: Math.round(performance.now() - browserStarted), clientRequest: sequence, tool: browserTool, ...(browserCall ? { call: browserCall } : {}) }); };
          try {
            if(descriptor.id.startsWith('browser.')){await this.receiptAcks;const admitting=this.admissionInFlight??=(async()=>{const admission=await this.admission.request();if(this.closed)throw new Error('closed');if(admission)await toolRequest('browser-admit',admission);})();try{await admitting;}finally{if(this.admissionInFlight===admitting)this.admissionInFlight=undefined;}}
            this.diagnostic('POST /invoke', 'request');
            const result = await toolRequest('invoke', { invocationId: details?.toolCall?.callId ?? crypto.randomUUID(), toolId: descriptor.id, input }, 'POST', browserTool ? { sequence, response: call => { browserCall = call; } } : undefined) as ToolResult;
            if (this.closed) { browserResult('CLOSED'); return { status: 'error', message: 'Sesión cerrada.' }; }
            this.pending = result.status === 'pending' ? result : null; this.armed = false; this.promptPlayback = undefined; this.captured.clear();
            this.diagnostic('tool.result', result.status === 'pending' ? 'prepared' : 'not_pending');
            const receivedState=browserExecutionStateSchema.safeParse((result as unknown as {browserExecutionState?:unknown}).browserExecutionState);if(receivedState.success){const meta=result as unknown as {browserRevision?:number;browserTaskActive?:boolean};this.present({executionState:receivedState.data,revision:meta.browserRevision,taskActive:meta.browserTaskActive});}if(result.status==='pending')this.presentation?.state('WAITING_CONFIRMATION');
            await this.refresh();
            // Include events discovered during refresh in this exact function
            // output, before SDK response creation. agent_tool_end acknowledges
            // this receipt; HTTP success itself never consumes pending tokens.
            if(descriptor.id.startsWith('browser.')){const incorporated=this.browserContinuation.incorporatedState();if(incorporated)Object.assign(result,incorporated);}
            browserResult(result.status === 'error' ? browserCode(result.category) : 'OK');
            if (descriptor.id.startsWith('browser.') && result.status === 'error' && result.browserRecovery) {
              return { ...result, instruction: result.browserRecovery.recoverable
                ? 'Sin hablar: usa browserObservation si status es OK y resuelve el mismo paso con una ref nueva. Si FAILED, sólo observa para obtener contexto; no repitas acciones completadas. SNAPSHOT_CONSUMED significa contexto consumido, no cambios rápidos de página. Máximo dos recuperaciones, según el backend.'
                : 'Detente: no quedan recuperaciones para este paso. Da sólo un error final breve; no pidas intervención manual por un CONFLICT.' };
            }
            if (descriptor.id.startsWith('browser.')) { const state = browserExecutionStateSchema.safeParse((result as unknown as {browserExecutionState?:unknown}).browserExecutionState); if (state.success) {const relation=(result as unknown as {browserOutcomeRelation?:string}).browserOutcomeRelation;const read=descriptor.permission==='READ'||['browser.observe','browser.verify','browser.status','browser.tabs','browser.resume'].includes(descriptor.id);const outcome=actionOutcomeSchema.safeParse((result as unknown as {browserActionOutcome?:unknown}).browserActionOutcome);return {...result,...(outcome.success&&outcome.data.execution==='EXECUTED'&&result.status==='error'&&(relation!=='LAST_ACTION'||read)?{message:'La acción fue ejecutada; falló una lectura o la devolución posterior. No repitas la acción.'}:{}),instruction:executionInstruction(state.data)+(outcome.success?' '+(relation==='LAST_ACTION'?'Última acción registrada, distinta de esta invocación READ/control o fallo de validación: ':'')+outcomeInstruction(outcome.data):'')};} }
            return result;
          } catch {
            browserResult('UPSTREAM');
            // A lost HTTP result is not proof of task/action failure. Reconcile
            // the authoritative backend before presenting a terminal outcome.
            if (descriptor.id.startsWith('browser.')) {
              try {
                const activity=await toolRequest('activity',undefined,'GET') as {browser?:unknown};
                if(activity.browser){this.present(activity.browser);this.browserContinuation.update(activity.browser,this.confirmationActive,true);const state=activity.browser as {executionState?:unknown;actionOutcome?:unknown};const outcome=actionOutcomeSchema.safeParse(state.actionOutcome);const flow=browserExecutionStateSchema.safeParse(state.executionState);return {status:'error',category:'UPSTREAM',...(this.browserContinuation.incorporatedState()??{}),browserActionOutcome:outcome.success?outcome.data:null,browserExecutionState:flow.success?flow.data:undefined,browserOutcomeRelation:'LAST_ACTION',message:outcome.success&&outcome.data.execution==='EXECUTED'?'La última acción registrada fue ejecutada. No la repitas. Esta invocación perdió su resultado HTTP: reconciliá contexto READ antes de decidir cualquier paso.':'No se recibió el resultado. No reintentes ninguna acción ni asumas éxito; reconciliá el estado mediante READ.',instruction:'No repitas la invocación sin resultado ni la sustituyas por otra acción. Sólo reconciliación READ hasta identificar su ejecución. El outcome corresponde a la última acción registrada, no prueba por sí solo la ejecución de esta invocación. '+(flow.success?executionInstruction(flow.data):'')};}
              } catch { /* Transport uncertainty never turns into an action retry. */ }
              this.presentation?.state('INCONCLUSIVE');
            }
            return { status: 'error', message: 'No se pudo reconciliar el resultado. No reintentes la acción ni asumas éxito o fracaso; requiere comprobar el estado.' };
          }finally{if(descriptor.id.startsWith('browser.')){--this.browserInvocations;this.browserContinuation.released(this.browserBusy());}}
        } })) };
  }
  private registerPromptResponse(responseId: string): void {
    // A WebRTC output buffer may continue across responses: its stopped response
    // need not have a matching started event. Bind the post-tool response itself.
    // Once bound, acknowledgments/repeated tools cannot replace this prompt.
    const alreadyObserved = this.observedResponses.has(responseId);
    this.observedResponses.add(responseId);
    if (!alreadyObserved && this.pending && responseId && !this.promptPlayback && !this.armed) {
      this.promptPlayback = { confirmationId: this.pending.confirmationId, responseId, interrupted: false };
      this.diagnostic('prompt.register', 'post_tool_response', { responseId });
    }
  }
  playbackStarted(responseId: string): void {
    this.registerPromptResponse(responseId);
    this.diagnostic('playback.start', this.pending ? 'prompt_playing' : 'no_pending', { responseId });
  }
  playbackFinished(responseId: string): void {
    if (this.pending && this.promptPlayback?.confirmationId === this.pending.confirmationId && this.promptPlayback.responseId === responseId && !this.promptPlayback.interrupted) this.armed = true;
    this.diagnostic('playback.finish', this.armed ? 'awaiting_confirmation' : 'not_armed', { responseId });
  }
  async transportEvent(event: { type: string; [key: string]: unknown }): Promise<void> {
    const observed = ['output_audio_buffer.started', 'output_audio_buffer.stopped', 'output_audio_buffer.cleared', 'input_audio_buffer.speech_started', 'input_audio_buffer.speech_stopped', 'conversation.item.input_audio_transcription.completed', 'conversation.item.created', 'conversation.item.added', 'response.created', 'response.done', 'response.output_item.added', 'response.output_item.done', 'response.function_call_arguments.done'];
    if (observed.includes(event.type)) {
      const response = event.response as { id?: unknown } | undefined;
      const item = event.item as { id?: unknown } | undefined;
      this.diagnostic(event.type, 'transport_received', {
        responseId: typeof event.response_id === 'string' ? event.response_id : typeof response?.id === 'string' ? response.id : undefined,
        itemId: typeof event.item_id === 'string' ? event.item_id : typeof item?.id === 'string' ? item.id : undefined });
    }
    this.traceResponse(event);
    // Response lifecycle schedules deferred decisions only; it never closes a task.
    if(event.type==='response.output_item.added'){
      const item=event.item as {type?:string;name?:string;call_id?:string}|undefined;
      if(item?.type==='function_call'&&item.name&&this.sdkToolNames.has(item.name)&&item.call_id&&!this.sdkCommitted.has(item.call_id))this.sdkAnnounced.add(item.call_id);
    }
    if(event.type==='response.created'){
      const response=event.response as {id?:string}|undefined;
      if((this.sdkAwaitingResponse||['RUNNING','RECOVERING_CONTEXT'].includes(this.browserContinuation.traceContext().taskState??''))&&response?.id){this.sdkAwaitingResponse=false;this.sdkResponses.add(response.id);}
    }
    if(event.type==='response.done'){
      const response=event.response as {id?:string}|undefined;if(response?.id)this.sdkResponses.delete(response.id);
      this.browserContinuation.released(this.browserBusy());
    }
    switch (event.type) {
      case 'response.created': {
        const response = event.response as { id?: unknown } | undefined;
        if (typeof response?.id === 'string') {this.registerPromptResponse(response.id);this.taskDiagnostics.event({stage:'RESPONSE_CREATED',relation:'NEXT_RESPONSE_CANDIDATE',...this.browserContinuation.traceContext(),...(/^resp_[A-Za-z0-9_-]{1,100}$/.test(response.id)?{responseId:response.id}:{}),...this.traceSchedule(),tokens:this.responseTrace.get(response.id)?.tokens??[]});}
        break;
      }
      case 'response.done': {
        const response = event.response as { id?: unknown; status?: unknown } | undefined;
        if (this.promptPlayback && response?.id === this.promptPlayback.responseId &&
          ['cancelled', 'failed', 'incomplete'].includes(String(response.status))) {
          this.promptPlayback.interrupted = true; this.armed = false;
          this.diagnostic('prompt.incomplete', 'generation_not_completed');
        }
        // Generation completion alone is never proof of completed playback.
        break;
      }
      case 'output_audio_buffer.started':
        if (typeof event.response_id === 'string') this.playbackStarted(event.response_id);
        else this.diagnostic('playback.start', 'missing_response_id');
        break;
      case 'output_audio_buffer.stopped':
        if (typeof event.response_id === 'string') this.playbackFinished(event.response_id);
        else this.diagnostic('playback.finish', 'missing_response_id');
        break;
      case 'output_audio_buffer.cleared': {
        // Clearing a later acknowledgment does not undo a completed prompt.
        const prompt = this.promptPlayback;
        if (!this.armed && prompt && (typeof event.response_id !== 'string' || event.response_id === prompt.responseId)) {
          prompt.interrupted = true;
          this.diagnostic('playback.clear', 'prompt_interrupted');
        } else this.diagnostic('playback.clear', 'not_active_prompt');
        break;
      }
      case 'input_audio_buffer.speech_started':
        if (typeof event.item_id === 'string') this.speechStarted(event.item_id);
        break;
      case 'conversation.item.input_audio_transcription.completed':
        if (typeof event.item_id === 'string' && typeof event.transcript === 'string') await this.transcript(event.item_id, event.transcript);
        break;
    }
  }
  speechStarted(itemId: string): void {
    if(this.lifecycleEnabled&&!this.confirmationActive&&!['RUNNING','RECOVERING_CONTEXT','WAITING_ACCESS','WAITING_MANUAL','WAITING_CONFIRMATION'].includes(this.lastBrowserState??''))this.admission.begin(itemId);
    if(!this.confirmationActive&&!this.closed&&this.browserUserTurns.size<200)this.browserUserTurns.add(itemId);
    this.browserContinuation.speechStarted(itemId, this.confirmationActive);
    // A new turn supersedes an unresolved semantic decision. Old classification
    // must not execute while the user is already correcting or changing intent.
    if (this.intentInFlight && !this.captured.has(itemId)) ++this.intentRevision;
    if (!this.captured.has(itemId) && this.pending && this.pending.expiresAt > Date.now()) this.captured.set(itemId, { id: this.pending.confirmationId, approvable: this.armed });
    const capture = this.captured.get(itemId);
    this.diagnostic('speech.capture', capture ? 'captured' : 'not_captured', { itemId, capturedId: capture?.id, capturedApprovable: capture?.approvable });
  }
  async transcript(itemId: string, text: string): Promise<void> {
    const browserUserTurn=this.browserUserTurns.delete(itemId);
    if(browserUserTurn&&!this.confirmationActive)this.admission.capture(itemId,text);
    if (!this.confirmationActive) {if(this.lifecycleEnabled&&browserUserTurn&&explicitBrowserCancellation(text)){const result=await toolRequest('browser-cancel',{itemId,utterance:text}).catch(()=>undefined);if(result&&typeof result==='object'&&(result as {cancelled?:boolean}).cancelled)this.admission.clear();}await this.browserContinuation.transcript(itemId, text, false);}
    if (!this.pending || this.closed) { this.diagnostic('transcript.classify', 'no_pending_or_closed', { itemId }); return; }
    const capture = this.captured.get(itemId); this.captured.delete(itemId);
    const pendingId = this.pending.confirmationId;
    if (capture?.id !== pendingId) {
      this.diagnostic('transcript.classify', 'missing_or_stale_capture', { itemId, capturedId: capture?.id }); return;
    }
    const revision = ++this.intentRevision;
    this.intentInFlight++;
    let intent: import('../tools/confirmation-intent.js').ConfirmationIntent = 'ambiguous';
    try {
      this.diagnostic('POST /intent', 'classifying', { itemId, capturedId: pendingId, capturedApprovable: capture.approvable });
      const result = await toolRequest('intent', { confirmationId: pendingId, utterance: text }) as { confirmationId?: unknown; intent?: unknown };
      if (result.confirmationId === pendingId) intent = intentSchema.parse(result.intent);
    } catch { /* Unavailable/malformed classifier never grants approval. */ }
    finally { this.intentInFlight--; }
    if (this.closed || revision !== this.intentRevision || this.pending?.confirmationId !== pendingId) {
      this.diagnostic('intent.ignore', 'superseded_or_closed', { itemId, capturedId: pendingId }); return;
    }
    const approved = intent === 'affirmative';
    const rejected = intent === 'negative';
    this.diagnostic('transcript.classify', capture?.id === this.pending.confirmationId ? 'matching_capture' : 'missing_or_stale_capture', { itemId, capturedId: capture?.id, capturedApprovable: capture?.approvable, classification: intent });
    if (rejected && capture?.id === this.pending.confirmationId) { await this.decide(false); return; }
    if (approved) {
      if (capture?.approvable && capture.id === this.pending.confirmationId) await this.decide(true);
      else this.diagnostic('transcript.ignore', 'affirmative_but_ineligible', { itemId, capturedId: capture?.id, capturedApprovable: capture?.approvable });
      // An early/stale affirmative is not a request change and cannot execute.
      return;
    }
    // Ambiguity invalidates too: a later yes must not approve an uncertain old turn.
    // Correction/unrelated speech never reuses the frozen payload.
    // Do not let delayed transcripts or an unrelated utterance approve an action.
    if (capture?.id === this.pending.confirmationId) {
      this.diagnostic('POST /cancel', intent === 'ambiguous' ? 'ambiguous_matching_capture' : intent === 'correction' ? 'correction_matching_capture' : 'unrelated_matching_capture', { itemId, capturedId: capture.id, capturedApprovable: capture.approvable });
      const cancelledId = this.pending.confirmationId;
      this.decisionInFlight = true;
      this.pending = null; this.armed = false; this.promptPlayback = undefined; this.captured.clear();
      try {
        const cancellation = await toolRequest('cancel', { confirmationId: cancelledId }) as { cancelled?: unknown };
        if (cancellation.cancelled !== true) throw new Error('Cancellation not confirmed');
        if (!this.closed && intent === 'ambiguous') this.notify('Resultado del backend: la confirmación se canceló porque no se pudo determinar una aprobación inequívoca. La acción no se ejecutó. Pide una aclaración; no reintentes automáticamente.');
        else if (!this.closed) this.notify(`Resultado del backend: la confirmación ${cancelledId} se canceló porque el usuario cambió de solicitud. Esa acción ya no está pendiente y no se ejecutó. Puedes preparar inmediatamente una NUEVA confirmación con la solicitud corregida; no esperes su rechazo ni su caducidad.`);
      } catch {
        if (!this.closed) this.notify('No se pudo verificar la cancelación. No asumas que la acción se ejecutó ni repitas una escritura sin comprobar su estado.');
      }
      await this.refresh();
      this.decisionInFlight = false;
    }
  }
  async decide(approved: boolean): Promise<void> {
    const pending = this.pending; if (!pending || this.closed) return;
    ++this.intentRevision;
    this.diagnostic('POST /decision', approved ? 'approved' : 'rejected');
    // Clear speech captures immediately, but keep model invocations blocked until
    // the authoritative decision result (not the user's yes) has been received.
    this.decisionInFlight = true;
    this.pending = null; this.armed = false; this.promptPlayback = undefined; this.captured.clear();
    try { const result = await toolRequest('decision', { confirmationId: pending.confirmationId, approved });
      if (!this.closed) this.notify(`Resultado del backend para la confirmación ${pending.confirmationId}: ${JSON.stringify(result)}. Comunica el resultado brevemente; no repitas la acción.`);
    } catch { if (!this.closed) this.notify('No se pudo confirmar la acción. No asumas éxito ni repitas una escritura sin comprobar su estado.'); }
    await this.refresh();
    this.decisionInFlight = false;
  }
  private async refresh(): Promise<void> {
    if (this.closed) return;
    const expectedId = this.pending?.confirmationId;
    try { const data = await toolRequest('activity', undefined, 'GET') as { activity: ToolActivity[]; pending: PendingConfirmation | null; browser?: unknown };
      if (this.closed) return;
      if (this.pending && this.pending.confirmationId === expectedId && (!data.pending || data.pending.confirmationId !== this.pending.confirmationId)) { this.diagnostic('activity.refresh', 'backend_pending_missing_or_changed'); this.pending = null; this.armed = false; }
      this.activity(data.activity, this.pending);
      if (data.browser) {const state=browserExecutionStateSchema.safeParse((data.browser as {executionState?:unknown}).executionState);if(state.success&&this.browserInvocations===0)this.present(data.browser);this.browserContinuation.update(data.browser, this.confirmationActive,this.browserBusy());}
    } catch { /* Polling never breaks voice playback. Tool requests report failures. */ }
  }
  close(): void { this.diagnostic('bridge.close', 'session_closed'); this.closed = true; this.admission.clear(); this.browserContinuation.close(); this.sdkPending.clear();this.sdkCommitted.clear();this.sdkToolNames.clear();this.sdkAnnounced.clear();this.sdkResponses.clear();this.sdkAwaitingResponse=false;this.browserUserTurns.clear();this.responseTrace.clear();this.requestedTraceTokens=[];this.observedResponses.clear(); clearInterval(this.polling); this.pending = null; this.captured.clear(); void toolRequest('session', undefined, 'DELETE').catch(() => undefined); }
}
