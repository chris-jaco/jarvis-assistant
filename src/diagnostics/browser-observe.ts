import { z } from 'zod';
// Structural metadata only. No raw errors, origins, DOM or tool arguments.
export const observeTraceSchema = z.object({
 boundary:z.enum(['BACKEND','EXTENSION','CONTENT']).optional(),
 stage:z.enum(['OBSERVE_AUTH','CONTENT_TRANSPORT','OBSERVE_RESULT','WORKFLOW_TRANSITION']),
 requestId:z.string().uuid().optional(),taskId:z.string().uuid().optional(),admissionId:z.string().uuid().optional(),
 chromePermission:z.boolean().optional(),persistentPolicy:z.enum(['ALLOW','ASK','UNKNOWN']).optional(),taskGrant:z.enum(['PRESENT','MISSING','INCOMPATIBLE','EXPIRED','REVOKED']).optional(),sameOrigin:z.boolean().optional(),
 injection:z.enum(['INJECTED','FAILED','NOT_ATTEMPTED']).optional(),initialization:z.enum(['OK','FAILED','NOT_ATTEMPTED']).optional(),dispatch:z.enum(['SENT','FAILED','NOT_ATTEMPTED']).optional(),reply:z.enum(['RECEIVED','TIMEOUT','ERROR','NOT_RECEIVED']).optional(),
 outcome:z.enum(['OK','ERROR','ACCESS_PENDING','REQUIRES_USER_INTERACTION']).optional(),
 hasSnapshot:z.boolean().optional(),hasDocumentId:z.boolean().optional(),hasScopeId:z.boolean().optional(),bindingCoherent:z.boolean().optional(),snapshotValid:z.boolean().optional(),refCount:z.number().int().min(0).max(40).optional(),capabilityCount:z.number().int().min(0).max(120).optional(),
 contextState:z.enum(['READY','OBSERVATION_REQUIRED']).optional(),from:z.enum(['READY','REQUIRED','RECOVERING','INCONCLUSIVE','NONE','RUNNING','RECOVERING_CONTEXT','TASK_ACCEPTED','WAITING_ACCESS','WAITING_MANUAL','WAITING_CONFIRMATION','COMPLETED','FAILED']).optional(),to:z.enum(['READY','REQUIRED','RECOVERING','INCONCLUSIVE','NONE','RUNNING','RECOVERING_CONTEXT','TASK_ACCEPTED','WAITING_ACCESS','WAITING_MANUAL','WAITING_CONFIRMATION','COMPLETED','FAILED']).optional(),attempts:z.number().int().min(0).max(2).optional(),
 failureReason:z.enum(['NONE','UNCONFIGURED','AMBIGUOUS','CONFLICT','LIMIT','INVALID_INPUT','AUTH_DIAGNOSTIC_UNAVAILABLE','BINDING_UNAVAILABLE','SNAPSHOT_INVALID','SNAPSHOT_EXPIRED','INIT_REJECTED','INJECTION_FAILED','MESSAGING_FAILED','REPLY_INVALID','ACCESS_DENIED','CONTENT_UNAVAILABLE','EXPIRED','STALE_REF','DISCONNECTED','TIMEOUT','UNSUPPORTED','REJECTED','EXECUTION_UNKNOWN','UPSTREAM','OBSERVATION_REQUIRED','DOCUMENT_CHANGED','ELEMENT_CHANGED','SNAPSHOT_CONSUMED','CAPTCHA','AUTHENTICATION','MFA','CHALLENGE','ORIGIN_PERMISSION','UNSUPPORTED_CONTROL','MEDIA_USER_GESTURE','STEP_PENDING','READ_BUDGET_EXHAUSTED','FRESH_CONTEXT','ADMISSION_RESET','TAB_UNAVAILABLE','TOOL_STARTED','TOOL_RESULT','READ_RECOVERY','RECOVERY_COMPLETED','RECOVERY_INCONCLUSIVE']).optional()
}).strict();
export type ObserveTrace = z.infer<typeof observeTraceSchema>;
export function observeTracer(enabled:boolean,sink:(row:ObserveTrace)=>void=row=>console.info('[ATLAS browser observe]',JSON.stringify(row))):(raw:unknown)=>void {
 return raw=>{if(!enabled)return;const parsed=observeTraceSchema.safeParse(raw);if(parsed.success)try{sink(parsed.data);}catch{/* Diagnostics never determine execution. */}};
}
export function observationFacts(raw:unknown):Pick<ObserveTrace,'hasSnapshot'|'hasDocumentId'|'hasScopeId'|'refCount'|'capabilityCount'> {
 const data=raw&&typeof raw==='object'?raw as Record<string,unknown>:{};const elements=Array.isArray(data.elements)?data.elements:[];
 return {hasSnapshot:typeof data.snapshotId==='string',hasDocumentId:typeof data.documentId==='string',hasScopeId:typeof data.scopeId==='string',refCount:Math.min(40,elements.length),capabilityCount:Math.min(120,elements.reduce((n,el)=>n+(el&&Array.isArray(el.capabilities)?el.capabilities.length:0),0))};
}
