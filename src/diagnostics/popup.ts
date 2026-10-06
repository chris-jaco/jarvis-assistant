import { z } from 'zod';
export const popupStages=['popup_opened','state_requested','worker_handler_entered','state_ready','authorization_click','permission_result','policy_saved','grant_created','notification_posted','backend_received','continuation_sent','next_task_tool'] as const;
export const popupTraceSchema=z.object({correlationId:z.string().uuid(),stage:z.enum(popupStages),outcome:z.enum(['START','OK','FAILED','DENIED','OUT_OF_ORDER','CLOSED','NOT_APPLICABLE']),durationMs:z.number().nonnegative().max(60000).optional()}).strict();
export type PopupTrace=z.infer<typeof popupTraceSchema>;
export class PopupDiagnostics {
  private active=false;private pending:PopupTrace[]|undefined;
  get enabled():boolean{return this.active;}
  set enabled(value:boolean){this.active=value;const pending=this.pending;this.pending=undefined;if(value&&pending)for(const row of pending)try{this.sink(row);}catch{}}
  constructor(private readonly sink:(row:PopupTrace)=>void= row=>console.debug('[ATLAS access]',JSON.stringify(row)),defer=false){if(defer)this.pending=[];}
  event(correlationId:string,stage:PopupTrace['stage'],outcome:PopupTrace['outcome']='OK',durationMs?:number):void {
    if(!this.enabled&&!this.pending)return;const parsed=popupTraceSchema.safeParse({correlationId,stage,outcome,...(durationMs!==undefined?{durationMs:Math.min(60000,Math.max(0,durationMs))}:{})});
    if(parsed.success){if(this.pending){if(this.pending.length<256)this.pending.push(parsed.data);return;}try{this.sink(parsed.data);}catch{}}
  }
}
