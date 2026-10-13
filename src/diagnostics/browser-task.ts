import { z } from 'zod';
import { browserExecutionStateSchema } from '../browser/execution-state.js';
export const sessionCloseReasonSchema=z.enum(['REALTIME_ERROR','TRANSPORT_DISCONNECTED','USER_DISCONNECT','PAGEHIDE','RECONNECT','CONNECT_TIMEOUT','CONNECT_FAILURE','INTERRUPT_FAILURE','SERVER_SHUTDOWN','UNKNOWN']);
export type SessionCloseReason=z.infer<typeof sessionCloseReasonSchema>;
const errorTypeSchema=z.enum(['AbortError','NotAllowedError','NetworkError','TimeoutError','TypeError','invalid_request_error','server_error','transcription_error']);
const errorCodeSchema=z.enum(['ECONNRESET','ETIMEDOUT','ECONNABORTED','NETWORK_ERROR','SESSION_EXPIRED','RATE_LIMITED','session_expired','rate_limit_exceeded','conversation_already_has_active_response','invalid_event','invalid_value','invalid_type','missing_required_parameter','UNKNOWN']);
const errorEventKindSchema=z.enum(['CONVERSATION_ITEM_CREATE','RESPONSE_CREATE','UNKNOWN']);
const errorParamSchema=z.enum(['item','item.id','item.type','item.role','item.content','response','response.metadata','type','UNKNOWN']);
type RealtimeErrorCandidate={name?:unknown;type?:unknown;code?:unknown;param?:unknown;event_id?:unknown;error?:unknown};
function realtimeErrorCandidate(error:unknown):RealtimeErrorCandidate|undefined {
  try {
    if(!error||typeof error!=='object')return;
    // The SDK emits {type:'error',error}, and server errors may nest a second
    // {type:'error',error:{type,code}}. Inspect only these fixed properties.
    let candidate=error as RealtimeErrorCandidate;
    for(let depth=0;depth<2&&candidate.type==='error'&&candidate.error&&typeof candidate.error==='object';depth++)candidate=candidate.error as typeof candidate;
    return candidate;
  }catch{return;}
}
export class RealtimeErrorCorrelation {
  constructor(private readonly generation:number) {}
  facts(error:unknown):ReturnType<typeof realtimeErrorFacts> {
    const candidate=realtimeErrorCandidate(error),linked=typeof candidate?.event_id==='string'?candidate.event_id:'',param=typeof candidate?.param==='string'?candidate.param:'';
    const errorEventKind=/^item(?:\.|$)/.test(param)?'CONVERSATION_ITEM_CREATE':/^agents_js_response_create_[1-9]\d*$/.test(linked)||/^response(?:\.|$)/.test(param)?'RESPONSE_CREATE':'UNKNOWN';
    return realtimeErrorFacts(error,errorEventKind);
  }
  clear():void {void this.generation;}
}
export function realtimeErrorFacts(error:unknown,errorEventKind:z.infer<typeof errorEventKindSchema>='UNKNOWN'):{errorType?:z.infer<typeof errorTypeSchema>;errorCode:z.infer<typeof errorCodeSchema>;errorEventKind:z.infer<typeof errorEventKindSchema>;errorParam:z.infer<typeof errorParamSchema>} {
  const candidate=realtimeErrorCandidate(error),type=errorTypeSchema.safeParse(candidate?.name??candidate?.type),code=errorCodeSchema.safeParse(candidate?.code),param=errorParamSchema.safeParse(candidate?.param);
  return {...(type.success?{errorType:type.data}:{}),errorCode:code.success?code.data:'UNKNOWN',errorEventKind,errorParam:param.success?param.data:'UNKNOWN'};
}
const traceSchema=z.object({
  taskId:z.string().uuid().optional(),admissionId:z.string().uuid().optional(),tokenId:z.string().uuid().optional(),tokens:z.array(z.string().uuid()).max(3).optional(),correlationId:z.string().uuid().optional(),
  at:z.number().finite().nonnegative().optional(),call:z.string().regex(/^b[1-9]\d{0,8}$/).optional(),
  responseId:z.string().regex(/^resp_[A-Za-z0-9_-]{1,100}$/).optional(),callId:z.string().regex(/^call_[A-Za-z0-9_-]{1,100}$/).optional(),
  stage:z.enum(['CONTINUATION','END_TASK','RESPONSE_CREATED','TOOL_COMMITTED','WORKFLOW','ADMISSION','ADMISSION_PRESERVED','DRAFT_AUTHORITY','DRAFT_PRECONDITION','DRAFT_CONTINUATION','TOOL_CATALOG','WRITE_CONFIRMATION','WRITE_EXECUTION','END_TASK_GUARD','CONTINUATION_BLOCKED','RESPONSE_REQUESTED','RESPONSE_DONE','RESPONSE_OUTPUT','PRESENTATION','PLAYBACK','REALTIME_SESSION_ERROR','REALTIME_TRANSPORT_STATE','TOOLS_SESSION_DELETE','MANUAL_REQUEST_CREATED','MANUAL_POPUP_SELECTED','MANUAL_EVENT_EMITTED','MANUAL_EVENT_RECEIVED','MANUAL_CONTINUATION_PENDING','MANUAL_CONTINUATION_DELIVERED','MANUAL_CONTINUATION_CONSUMED']),
  manualRequestId:z.string().uuid().optional(),manualStatus:z.enum(['SELECTED','CANCELLED','EXPIRED','INVALIDATED']).optional(),
  connectionGeneration:z.number().int().min(1).max(1_000_000).optional(),elapsedMs:z.number().int().min(0).max(86_400_000).optional(),
  sessionStage:z.enum(['TOKEN','TOOLS','MEMORY','CONNECTING','CONNECTED']).optional(),transportState:z.enum(['UNKNOWN','CONNECTING','CONNECTED','DISCONNECTED','FAILED']).optional(),
  errorType:errorTypeSchema.optional(),errorCode:errorCodeSchema.optional(),errorEventKind:errorEventKindSchema.optional(),errorParam:errorParamSchema.optional(),closeReason:sessionCloseReasonSchema.optional(),
  intent:z.enum(['READ_ONLY','ACTION_REQUIRED']).optional(),source:z.enum(['TRANSCRIPT','FALLBACK','SDK_OUTPUT','NOTIFICATION','BACKEND_EVENT']).optional(),
  phase:z.enum(['GUARD','TRANSPORT','RESULT']).optional(),
  sdkPendingCalls:z.number().int().min(0).optional(),sdkAnnouncedCalls:z.number().int().min(0).optional(),sdkActiveResponses:z.number().int().min(0).optional(),activeInvocations:z.number().int().min(0).optional(),
  sdkAwaitingResponse:z.boolean().optional(),coalesced:z.boolean().optional(),incorporatedBySdkOutput:z.boolean().optional(),
  tokenReason:z.enum(['ACCESS_READY','MANUAL_SELECTION_READY','CONTEXT_READY','CLOSE_REJECTED','UNSPECIFIED']).optional(),
  blockedBy:z.enum(['TOOL_OR_RESPONSE_IN_FLIGHT','CONFIRMATION','NOT_RUNNING','NOTIFY_FAILED']).optional(),
  guardMs:z.number().finite().min(0).max(30000).optional(),transportMs:z.number().finite().min(0).max(30000).optional(),
  guard:z.object({intent:z.enum(['READ_ONLY','ACTION_REQUIRED']),readObtained:z.boolean(),progress:z.boolean(),pending:z.boolean(),unknown:z.boolean(),fresh:z.boolean(),verificationRequired:z.boolean(),verified:z.boolean(),verificationExhausted:z.boolean(),cancelled:z.boolean(),terminal:z.boolean(),recoveryExhausted:z.boolean(),consequentialUnverified:z.boolean(),consequentialUnknown:z.boolean()}).strict().optional(),
  stateBefore:browserExecutionStateSchema.optional(),stateAfter:browserExecutionStateSchema.optional(),
  relation:z.enum(['REQUEST','NEXT_RESPONSE_CANDIDATE']).optional(),
  status:z.enum(['completed','cancelled','failed','incomplete','in_progress','UNKNOWN']).optional(),producedMessage:z.boolean().optional(),producedFunctionCall:z.boolean().optional(),
  muted:z.boolean().optional(),visibility:z.enum(['visible','hidden','prerender']).optional(),paused:z.boolean().optional(),ended:z.boolean().optional(),
  playback:z.enum(['STARTED','STOPPED','CLEARED']).optional(),muteReason:z.enum(['INITIAL','TURN_RUNNING','TURN_ACCEPTED','BEGIN_BROWSER','RESPONSE_CREATED','EXTRA_MESSAGE','PLAYBACK_ELIGIBILITY','CLOSE']).optional(),
  tokenState:z.enum(['RECEIVED','PENDING','DELIVERED','CONSUMED']).optional(),toolInFlight:z.boolean().optional(),
  taskState:browserExecutionStateSchema.optional(),requestedReason:z.enum(['COMPLETED','CANCELLED','TERMINAL','INCONCLUSIVE']).optional(),
  outcome:z.enum(['ACCEPTED','REJECTED','OK','ACCESS_PENDING','REQUIRES_USER_INTERACTION','ERROR']).optional(),
  reason:z.enum(['OBJECTIVE_PENDING','ORIGIN_PERMISSION','CAPTCHA','AUTHENTICATION','MFA','CHALLENGE','UNSUPPORTED_CONTROL','MEDIA_USER_GESTURE','CONVERSATION_SELECTION']).optional(),
  admissionRelation:z.enum(['INCIDENTAL']).optional(),draftGoal:z.enum(['PREPARE_PRIVATE_DRAFT','WRITE_DRAFT_TO_COMPOSER']).optional(),draftAuthority:z.enum(['EXACT_TRANSCRIPT']).optional(),draftAuthorityStatus:z.enum(['READY','TEXT_CONFIRMATION_REQUIRED','REJECTED']).optional(),draftRejectReason:z.enum(['MANUAL_SELECTION_MISSING','MANUAL_SELECTION_NOT_SELECTED','MANUAL_REQUEST_MISMATCH','ADMISSION_MISMATCH','TASK_MISMATCH','SCOPE_MISMATCH','TAB_MISMATCH','DOCUMENT_MISMATCH','EPOCH_MISMATCH','ORIGIN_MISMATCH','ACCESS_REVOKED','TASK_CANCELLED','WORKFLOW_PENDING','CONNECTION_CHANGED','DRAFT_EXPIRED','EXECUTION_UNCERTAIN','CONTENT_MISMATCH','OTHER_PRECONDITION']).optional(),
  continuationIntent:z.enum(['PRESERVED','MISMATCH']).optional(),writeDraftAvailability:z.enum(['AVAILABLE','UNAVAILABLE']).optional(),writeConfirmation:z.enum(['REQUESTED','ACCEPTED','REJECTED','EXPIRED']).optional(),writeExecution:z.enum(['DRAFT_WRITTEN','UNKNOWN','FAILED']).optional(),taskCompletion:z.enum(['ALLOWED','BLOCKED_PENDING_WRITE']).optional()
}).strict();
export type BrowserTaskTrace=z.infer<typeof traceSchema>;
export class BrowserTaskDiagnostics {
  enabled=false;
  constructor(private readonly sink:(row:BrowserTaskTrace)=>void=row=>console.debug('[ATLAS browser task]',JSON.stringify(row))){}
  event(raw:unknown):void {if(!this.enabled)return;const parsed=traceSchema.safeParse(raw);if(parsed.success)try{this.sink({...parsed.data,at:Date.now()});}catch{/* Diagnostics cannot alter orchestration. */}}
}
