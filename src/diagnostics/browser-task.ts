import { z } from 'zod';
import { browserExecutionStateSchema } from '../browser/execution-state.js';
const traceSchema=z.object({
  taskId:z.string().uuid().optional(),correlationId:z.string().uuid().optional(),
  responseId:z.string().regex(/^resp_[A-Za-z0-9_-]{1,100}$/).optional(),callId:z.string().regex(/^call_[A-Za-z0-9_-]{1,100}$/).optional(),
  stage:z.enum(['CONTINUATION','END_TASK','RESPONSE_CREATED','TOOL_COMMITTED','WORKFLOW']),
  tokenState:z.enum(['RECEIVED','PENDING','DELIVERED','CONSUMED']).optional(),toolInFlight:z.boolean().optional(),
  taskState:browserExecutionStateSchema.optional(),requestedReason:z.enum(['COMPLETED','CANCELLED','TERMINAL','INCONCLUSIVE']).optional(),
  outcome:z.enum(['ACCEPTED','REJECTED','OK','ACCESS_PENDING','REQUIRES_USER_INTERACTION','ERROR']).optional(),
  reason:z.enum(['OBJECTIVE_PENDING','ORIGIN_PERMISSION','CAPTCHA','AUTHENTICATION','MFA','CHALLENGE','UNSUPPORTED_CONTROL','MEDIA_USER_GESTURE']).optional()
}).strict();
export type BrowserTaskTrace=z.infer<typeof traceSchema>;
export class BrowserTaskDiagnostics {
  enabled=false;
  constructor(private readonly sink:(row:BrowserTaskTrace)=>void=row=>console.debug('[ATLAS browser task]',JSON.stringify(row))){}
  event(raw:unknown):void {if(!this.enabled)return;const parsed=traceSchema.safeParse(raw);if(parsed.success)try{this.sink(parsed.data);}catch{/* Diagnostics cannot alter orchestration. */}}
}
