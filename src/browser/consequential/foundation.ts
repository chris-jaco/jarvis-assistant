import { draftRequestSchema, draftContextSchema, resolveRecipient } from './semantic.js';
import type { DraftContext, Conversation } from './semantic.js';
import { createHash,randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ToolDefinition } from '../../tools/types.js';
import { ToolError } from '../../tools/types.js';
import { candidateSchema,intentSchema,authorizationSchema,resultSchema,manualSendResultSchema } from './contracts.js';
import type { Candidate,FrozenIntent,Authorization,ActionState,ConsequentialResult,ManualSendResult,TrustedContext } from './contracts.js';
import { PrivateExecutionJournal } from './journal.js';
const terminal=new Set<ActionState>(['SUCCESS','FAILURE','UNKNOWN','CANCELLED','REJECTED','EXPIRED','INVALIDATED']);
const inputSchema=z.object({recipientHint:z.string().min(1).max(120),text:z.string().min(1).max(2000)}).strict();
const proofSchema=z.object({simulationOnly:z.literal(true),evidence:z.literal('SIMULATED_MESSAGE_ACCEPTED')}).strict();
interface Entry {draft?:{conversation?:Readonly<Conversation>;selectionId?:string;snapshotId:string;contextDigest:string};intent:FrozenIntent;state:ActionState;confirmationId?:string;authorization?:Authorization;result?:ConsequentialResult;manualResult?:ManualSendResult;work?:Promise<ConsequentialResult>;manualWork?:Promise<ManualSendResult>;cancelled?:boolean;controller?:AbortController;}
export interface SimulatedExecutor {readonly simulationOnly:true;execute(intent:FrozenIntent,signal:AbortSignal):Promise<z.infer<typeof proofSchema>>;}
const candidateOf=(intent:FrozenIntent)=>{const {intentId:_id,kind:_kind,createdAt:_created,expiresAt:_expires,summary:_summary,...candidate}=intent;return candidateSchema.parse(candidate);};
const digest=(x:unknown)=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
function freeze<T>(x:T):T {if(x&&typeof x==='object'){for(const value of Object.values(x))freeze(value);Object.freeze(x);}return x;}
// The only dispatch executor remains simulated and test-only. Production uses
// the RAM-only draft mode, which cannot obtain approvals or execute.
export class ConsequentialFoundation {
 private entries=new Map<string,Entry>();private recovered=new Map<string,'SUCCESS'|'FAILURE'|'UNKNOWN'>();private initialized=false;private unresolved=false;private draftOnly=false;
 private manualSend?:{context:(signal:AbortSignal)=>Promise<DraftContext>;dispatch:(intent:FrozenIntent,signal:AbortSignal)=>Promise<{sendState:'NOT_SENT'|'DISPATCHED_UNVERIFIED';draftVisible:boolean}>};
 constructor(private readonly journal:PrivateExecutionJournal,private readonly context:(signal:AbortSignal)=>Promise<TrustedContext>,private readonly sessionId:string,private readonly simulator:SimulatedExecutor,private readonly now=Date.now,private readonly cancelPending?:(confirmationId:string)=>void){if(simulator.simulationOnly!==true)throw new ToolError('REJECTED');}
 // RAM-only FROZEN preparations share this ledger and invalidation machinery.
 // There is deliberately no journal I/O, approval hook or dispatch in this mode.
 static drafts(sessionId:string,now=Date.now,journal=new PrivateExecutionJournal()):ConsequentialFoundation {
  const foundation=new ConsequentialFoundation(journal,async()=>{throw new ToolError('REJECTED');},sessionId,{simulationOnly:true,execute:async()=>{throw new ToolError('REJECTED');}},now);
  foundation.initialized=true;foundation.draftOnly=true;return foundation;
 }
 async enableManualSend(context:(signal:AbortSignal)=>Promise<DraftContext>,dispatch:(intent:FrozenIntent,signal:AbortSignal)=>Promise<{sendState:'NOT_SENT'|'DISPATCHED_UNVERIFIED';draftVisible:boolean}>):Promise<void> {
  if(!this.draftOnly||this.manualSend)throw new ToolError('REJECTED');
  const recovered=await this.journal.recover();
  if(recovered.some(row=>row.state==='RESERVED'||row.state==='UNKNOWN'))this.unresolved=true;
  this.manualSend={context,dispatch};
 }
 get manualSendEnabled():boolean{return !!this.manualSend;}
 private store(candidate:Candidate,expiresAt:number,summary:string,draft?:Entry['draft']):Entry {
  const now=this.now();const intent=freeze(intentSchema.parse({...candidate,intentId:randomUUID(),kind:'SEND_MESSAGE',createdAt:now,expiresAt,summary}));
  const entry:Entry={intent,state:'RESOLVING',...(draft?{draft:freeze(draft)}:{})};this.entries.set(intent.intentId,entry);entry.state='FROZEN';return entry;
 }
 private draftAccess(raw:DraftContext):DraftContext {
  const context=draftContextSchema.parse(raw);
  if(context.backendSessionId!==this.sessionId||context.origin!==context.semantic.origin||Math.min(context.snapshotExpiresAt,context.grantExpiresAt,context.manualSelection?.expiresAt??Infinity)<=this.now())throw new ToolError('EXPIRED');
  if(context.manualSelection&&(context.manualSelection.admissionId!==context.admissionId||context.manualSelection.taskId!==context.taskId||context.manualSelection.scopeId!==context.scopeId||context.manualSelection.tabId!==context.tabId||context.manualSelection.documentId!==context.documentId||context.manualSelection.epoch!==context.connectionEpoch))throw new ToolError('REJECTED');
  return context;
 }
 private draftDigest(context:DraftContext,conversation:Conversation):string {
  const {snapshotId:_snapshot,snapshotExpiresAt:_expires,grantExpiresAt:_grant,semantic:_semantic,...binding}=context;
  return digest({binding,conversation});
 }
 prepareDraft(raw:unknown,trusted:DraftContext,signal:AbortSignal) {
  if(!this.draftOnly||this.entries.size>=100)throw new ToolError('REJECTED');signal.throwIfAborted();
  const request=draftRequestSchema.parse(raw),context=this.draftAccess(trusted);
  if(context.manualSelection){
   if(this.unresolved)throw new ToolError('EXECUTION_UNKNOWN');
   if(request.recipientIdentity)return {status:'INSUFFICIENT_EVIDENCE' as const,candidateCount:0,draftOnly:true as const};
   this.invalidateDrafts();
   const {semantic:_semantic,manualSelection:selection,snapshotId:_snapshot,snapshotExpiresAt:_expires,grantExpiresAt:_grant,chromePermission:_chrome,siteAuthorized:_site,grantValid:_valid,requestedIdentifiers:_identifiers,...binding}=context;
   const candidate=candidateSchema.parse({...binding,preparationId:randomUUID(),recipient:{identity:`user-selected:${selection.selectionId}`,displayName:request.recipientHint,evidenceId:selection.selectionId,uniqueness:'USER_SELECTED'},content:{text:request.text}});
   const contextDigest=digest({binding,selectionId:selection.selectionId});
   // Snapshot refs are short-lived, but execution performs fresh READs against
   // the selected conversation. Do not expire a voice confirmation merely
   // because the preparing observation had a 15-second ref lifetime.
   const entry=this.store(candidate,Math.min(this.now()+60_000,context.grantExpiresAt,selection.expiresAt),`Borrador privado para la conversación seleccionada por vos (${JSON.stringify(request.recipientHint)}). No se ha escrito ni enviado.`,{selectionId:selection.selectionId,snapshotId:context.snapshotId,contextDigest});
   return this.draftView(entry);
  }
  if(request.recipientIdentity&&!context.requestedIdentifiers.includes(request.recipientIdentity))return {status:'IDENTITY_REQUIRED' as const,candidateCount:0,draftOnly:true as const};
  const resolved=resolveRecipient(context.semantic,request);
  if(resolved.status!=='VERIFIED')return {...resolved,draftOnly:true as const};
  // Replace prior drafts; editing is a new frozen preparation, never mutation.
  this.invalidateDrafts();
  const conversation=resolved.conversation;
  const {semantic:_semantic,snapshotId:_snapshot,snapshotExpiresAt:_expires,grantExpiresAt:_grant,chromePermission:_chrome,siteAuthorized:_site,grantValid:_valid,requestedIdentifiers:_identifiers,...binding}=context;
  const candidate=candidateSchema.parse({...binding,preparationId:randomUUID(),recipient:{identity:request.recipientIdentity!,displayName:conversation.recipient.name,evidenceId:conversation.conversationId,uniqueness:'PROVEN'},content:{text:request.text}});
  const entry=this.store(candidate,Math.min(this.now()+60_000,context.snapshotExpiresAt,context.grantExpiresAt),`Borrador privado para ${JSON.stringify(conversation.recipient.name)}. No se ha escrito ni enviado.`,{conversation,snapshotId:context.snapshotId,contextDigest:this.draftDigest(context,conversation)});
  return this.draftView(entry);
 }
  private draftView(entry:Entry) {return freeze({status:entry.state,draftOnly:true as const,intent:entry.intent,conversation:entry.draft!.conversation,selectionAssurance:entry.draft!.selectionId?'USER_SELECTED' as const:undefined,snapshotId:entry.draft!.snapshotId,confirmationEnabled:!!entry.draft!.selectionId&&!!this.manualSend,executionEnabled:false as const});}
 reviewDraft(id:string,trusted:DraftContext) {
  const entry=this.entry(id);if(!entry.draft)throw new ToolError('REJECTED');
  if(entry.intent.expiresAt<=this.now()){if(!terminal.has(entry.state)){if(entry.draft.selectionId)this.manualFailure(entry,'EXPIRED','EXPIRED');else this.failure(entry,'EXPIRED','EXPIRED');}return this.draftView(entry);}
  if(!terminal.has(entry.state))try {
   const context=this.draftAccess(trusted);
   if(entry.draft!.selectionId){
    const {semantic:_semantic,manualSelection:selection,snapshotId:_snapshot,snapshotExpiresAt:_expires,grantExpiresAt:_grant,chromePermission:_chrome,siteAuthorized:_site,grantValid:_valid,requestedIdentifiers:_identifiers,...binding}=context;
    if(!selection||selection.selectionId!==entry.draft!.selectionId||digest({binding,selectionId:selection.selectionId})!==entry.draft!.contextDigest)this.invalidate(id,'PRECONDITION_CHANGED');
   }else{
    const conversation=context.semantic.conversations.find(c=>c.conversationId===entry.draft!.conversation!.conversationId);
    if(context.semantic.truncated||!conversation||this.draftDigest(context,conversation)!==entry.draft!.contextDigest)this.invalidate(id,'PRECONDITION_CHANGED');
   }
  }catch{this.invalidate(id,'ACCESS_REVOKED');}
  return this.draftView(entry);
 }
 reviewStoredDraft(id:string) {
  const entry=this.entry(id);if(!entry.draft)throw new ToolError('REJECTED');
  if(entry.intent.expiresAt<=this.now()&&!terminal.has(entry.state)){if(entry.draft.selectionId)this.manualFailure(entry,'EXPIRED','EXPIRED');else this.failure(entry,'EXPIRED','EXPIRED');}
  return freeze({...this.draftView(entry),contextStatus:'NOT_REVALIDATED' as const});
 }
 reconcileDrafts(context:DraftContext) {for(const entry of this.entries.values())if(entry.draft&&!terminal.has(entry.state))this.reviewDraft(entry.intent.intentId,context);}
 invalidateDrafts() {for(const entry of this.entries.values())if(entry.draft&&!terminal.has(entry.state))this.invalidate(entry.intent.intentId,'PRECONDITION_CHANGED');}
 private manualFailure(e:Entry,state:ActionState,reason:ManualSendResult['reason'],draftVisible=false):ManualSendResult {
  e.state=state;return e.manualResult=manualSendResultSchema.parse({intentId:e.intent.intentId,...(e.authorization?{executionId:e.authorization.executionId}:{}),assurance:'USER_SELECTED',execution:'NOT_EXECUTED',verification:'INCONCLUSIVE',outcome:'ACTION_FAILED',reason,draftVisible});
 }
 private manualUnknown(e:Entry,reason:ManualSendResult['reason'],knownDispatch=false,draftVisible?:boolean):ManualSendResult {
  this.unresolved=true;e.state='UNKNOWN';return e.manualResult=manualSendResultSchema.parse({intentId:e.intent.intentId,executionId:e.authorization!.executionId,assurance:'USER_SELECTED',execution:knownDispatch?'DISPATCHED':'UNKNOWN',verification:'INCONCLUSIVE',outcome:knownDispatch?'ACTION_EXECUTED_UNVERIFIED':'EXECUTION_UNKNOWN',reason,...(draftVisible===undefined?{}:{draftVisible})});
 }
 async prepareManual(intentId:string,signal:AbortSignal):Promise<{intentId:string;summary:string}> {
  const e=this.entry(intentId);
  if(!this.manualSend||this.unresolved||!e.draft?.selectionId||e.state!=='FROZEN')throw new ToolError(this.unresolved?'EXECUTION_UNKNOWN':'REJECTED');
  const context=await this.manualSend.context(signal);signal.throwIfAborted();
  if(this.reviewDraft(intentId,context).status!=='FROZEN')throw new ToolError('CONFLICT');
  return {intentId,summary:`¿Confirmás enviar este texto exacto a la conversación que seleccionaste (${JSON.stringify(e.intent.recipient.displayName)})? ${JSON.stringify(e.intent.content.text)}. La identidad procede de tu selección; WhatsApp no la verificó para Atlas.`};
 }
 pendingManual(intentId:string,confirmationId:string,expiresAt:number):void {
  const e=this.entry(intentId);if(!this.manualSend||!e.draft?.selectionId||e.state!=='FROZEN'||e.intent.expiresAt<=this.now())throw new ToolError('EXPIRED');
  e.confirmationId=confirmationId;e.state='WAITING_CONFIRMATION';if(expiresAt<=this.now())this.manualFailure(e,'EXPIRED','EXPIRED');
 }
 decidedManual(intentId:string,confirmationId:string,approved:boolean):void {
  const e=this.entry(intentId);if(e.state!=='WAITING_CONFIRMATION'||e.confirmationId!==confirmationId)throw new ToolError('EXPIRED');
  if(e.intent.expiresAt<=this.now()){this.manualFailure(e,'EXPIRED','EXPIRED');throw new ToolError('EXPIRED');}
  if(!approved){this.manualFailure(e,'REJECTED','CANCELLED');return;}
  e.authorization=freeze(authorizationSchema.parse({intentId,confirmationId,executionId:randomUUID(),backendSessionId:e.intent.backendSessionId,bindingDigest:digest(candidateOf(e.intent)),deadlineAt:e.intent.expiresAt}));e.state='REVALIDATING';
 }
 async executeManual(intentId:string,signal:AbortSignal):Promise<ManualSendResult> {
  const e=this.entry(intentId);if(!this.manualSend||!e.draft?.selectionId)throw new ToolError('REJECTED');
  if(e.manualWork)return e.manualWork;if(e.manualResult)return e.manualResult;
  if(e.state!=='REVALIDATING'||!e.authorization)throw new ToolError('REJECTED');
  e.manualWork=this.runManual(e,signal);return e.manualWork;
 }
 private async runManual(e:Entry,signal:AbortSignal):Promise<ManualSendResult> {
  const auth=e.authorization!,executor=this.manualSend!;let reserved=false,dispatched=false,attemptedReserve=false;
  const controller=new AbortController();e.controller=controller;const abort=()=>controller.abort();signal.addEventListener('abort',abort,{once:true});const timer=setTimeout(abort,Math.max(1,auth.deadlineAt-this.now()));
  const valid=async()=>{controller.signal.throwIfAborted();if(e.cancelled||auth.deadlineAt<=this.now())throw new ToolError('EXPIRED');const context=await executor.context(controller.signal);controller.signal.throwIfAborted();if(e.cancelled||auth.deadlineAt<=this.now()||this.reviewDraft(e.intent.intentId,context).status!=='REVALIDATING')throw new ToolError('CONFLICT');};
  try{
   await valid();
   attemptedReserve=true;await this.journal.reserve({intentId:e.intent.intentId,executionId:auth.executionId,state:'RESERVED',updatedAt:this.now()});reserved=true;
   await valid(); // READ after durable reservation, before any possible effect.
   e.state='DISPATCH_RESERVED';e.state='EXECUTING';dispatched=true;
   const result=await executor.dispatch(e.intent,controller.signal);
   if(controller.signal.aborted||e.cancelled)throw new ToolError('EXECUTION_UNKNOWN');
   if(result.sendState==='NOT_SENT'){
    const failed=this.manualFailure(e,'FAILURE',result.draftVisible?'DRAFT_VISIBLE':'NO_SEND_CONTROL',result.draftVisible);
    await this.journal.finish(auth.executionId,'FAILURE',this.now());reserved=false;return failed;
   }
   const uncertain=this.manualUnknown(e,'DISPATCH_UNCERTAIN',true,result.draftVisible);
   await this.journal.finish(auth.executionId,'UNKNOWN',this.now()).catch(()=>{});reserved=false;return uncertain;
  }catch{
   if(e.manualResult){if(reserved)await this.journal.finish(auth.executionId,dispatched||e.manualResult.execution!=='NOT_EXECUTED'?'UNKNOWN':'FAILURE',this.now()).catch(()=>{});return e.manualResult;}
   const result=dispatched?this.manualUnknown(e,controller.signal.aborted?'TIMEOUT':'DISPATCH_UNCERTAIN'):this.manualFailure(e,'FAILURE',controller.signal.aborted?'TIMEOUT':reserved?'PRECONDITION_CHANGED':attemptedReserve?'JOURNAL_UNAVAILABLE':'ACCESS_REVOKED');
   if(reserved)await this.journal.finish(auth.executionId,dispatched?'UNKNOWN':'FAILURE',this.now()).catch(()=>{});
   return result;
  }finally{clearTimeout(timer);signal.removeEventListener('abort',abort);e.controller=undefined;}
 }
 async initialize(){if(this.initialized)return;for(const row of await this.journal.recover()){this.recovered.set(row.intentId,row.state==='RESERVED'?'UNKNOWN':row.state);if(row.state==='UNKNOWN')this.unresolved=true;}this.initialized=true;}
 private access(context:TrustedContext){if(!context.chromePermission||!context.siteAuthorized||!context.grantValid||context.grantExpiresAt<=this.now())throw new ToolError('REJECTED');const candidate=candidateSchema.parse(context.candidate);if(candidate.backendSessionId!==this.sessionId)throw new ToolError('REJECTED');return candidate;}
 async prepare(raw:unknown,signal:AbortSignal):Promise<{intentId:string}>{if(this.unresolved)throw new ToolError('EXECUTION_UNKNOWN');if(!this.initialized||this.entries.size>=100)throw new ToolError('UNCONFIGURED');const request=inputSchema.parse(raw);signal.throwIfAborted();const context=await this.context(signal);signal.throwIfAborted();const candidate=this.access(context);
 if(candidate.recipient.displayName!==request.recipientHint||candidate.content.text!==request.text)throw new ToolError('CONFLICT');
 const now=this.now();const entry=this.store(candidate,Math.min(now+60_000,context.grantExpiresAt),`SIMULACIÓN: ¿Confirmás enviar a ${JSON.stringify(candidate.recipient.displayName)} (${JSON.stringify(candidate.recipient.identity)}) este texto exacto: ${JSON.stringify(candidate.content.text)}? No se enviará ningún mensaje real.`);return {intentId:entry.intent.intentId};}
 private entry(id:string){const e=this.entries.get(id);if(!e||e.intent.backendSessionId!==this.sessionId||this.recovered.has(id))throw new ToolError('EXPIRED');return e;}
 private failure(e:Entry,state:ActionState,reason:ConsequentialResult['reason']){e.state=state;e.result=resultSchema.parse({intentId:e.intent.intentId,...(e.authorization?{executionId:e.authorization.executionId}:{}),simulationOnly:true,execution:'NOT_EXECUTED',verification:'FAILED',outcome:'CONFIRMED_FAILURE',reason});return e.result;}
 private unknown(e:Entry,reason:ConsequentialResult['reason']){this.unresolved=true;e.state='UNKNOWN';e.result=resultSchema.parse({intentId:e.intent.intentId,executionId:e.authorization!.executionId,simulationOnly:true,execution:'UNKNOWN',verification:'INCONCLUSIVE',outcome:'EXECUTION_UNKNOWN',reason});return e.result;}
 private pending(id:string,confirmationId:string,expiresAt:number){const e=this.entry(id);if(e.draft||this.draftOnly)throw new ToolError('REJECTED');if(e.state!=='FROZEN'||e.intent.expiresAt<=this.now())throw new ToolError('EXPIRED');e.confirmationId=confirmationId;e.state='WAITING_CONFIRMATION';if(expiresAt<=this.now())this.failure(e,'EXPIRED','EXPIRED');}
 private decided(id:string,confirmationId:string,approved:boolean){const e=this.entry(id);if(e.state!=='WAITING_CONFIRMATION'||e.confirmationId!==confirmationId)throw new ToolError('EXPIRED');if(e.intent.expiresAt<=this.now()){this.failure(e,'EXPIRED','EXPIRED');throw new ToolError('EXPIRED');}if(!approved){this.failure(e,'REJECTED','CANCELLED');return;}e.authorization=freeze(authorizationSchema.parse({intentId:id,confirmationId,executionId:randomUUID(),backendSessionId:e.intent.backendSessionId,bindingDigest:digest(candidateOf(e.intent)),deadlineAt:e.intent.expiresAt}));e.state='REVALIDATING';}
 invalidate(intentId:string,reason:'CANCELLED'|'ACCESS_REVOKED'|'PRECONDITION_CHANGED'='CANCELLED'){const e=this.entry(intentId);if(terminal.has(e.state))return;e.cancelled=true;if(e.draft?.selectionId){if(['DISPATCH_RESERVED','EXECUTING','VERIFYING'].includes(e.state))this.manualUnknown(e,reason==='CANCELLED'?'CANCELLED':'ACCESS_REVOKED');else this.manualFailure(e,reason==='PRECONDITION_CHANGED'?'INVALIDATED':'CANCELLED',reason==='PRECONDITION_CHANGED'?'PRECONDITION_CHANGED':'CANCELLED');}else if(['DISPATCH_RESERVED','EXECUTING','VERIFYING'].includes(e.state))this.unknown(e,reason);else this.failure(e,reason==='PRECONDITION_CHANGED'?'INVALIDATED':'CANCELLED',reason);e.controller?.abort();if(e.confirmationId)this.cancelPending?.(e.confirmationId);}
 state(intentId:string){const e=this.entry(intentId);return {intentId,state:e.state,result:e.manualResult?structuredClone(e.manualResult):e.result?structuredClone(e.result):null};}
 recoveredState(intentId:string){return this.recovered.get(intentId);}
 private async run(e:Entry,signal:AbortSignal):Promise<ConsequentialResult>{const auth=e.authorization!;let reserved=false;let dispatched=false;const controller=new AbortController();e.controller=controller;const abort=()=>controller.abort();signal.addEventListener('abort',abort,{once:true});const timer=setTimeout(abort,Math.max(1,Math.min(15_000,auth.deadlineAt-this.now())));const ensure=()=>{if(e.cancelled||terminal.has(e.state)||controller.signal.aborted||signal.aborted||auth.deadlineAt<=this.now())throw new ToolError('TIMEOUT');};
 const readContext=()=>new Promise<TrustedContext>((resolve,reject)=>{const stop=()=>reject(new ToolError('TIMEOUT'));controller.signal.addEventListener('abort',stop,{once:true});if(controller.signal.aborted)stop();Promise.resolve().then(()=>this.context(controller.signal)).then(resolve,reject).finally(()=>controller.signal.removeEventListener('abort',stop));});
 try{ensure();const context=await readContext();ensure();const current=this.access(context);if(digest(current)!==auth.bindingDigest){return this.failure(e,'INVALIDATED','PRECONDITION_CHANGED');}
 e.state='DISPATCH_RESERVED';await this.journal.reserve({intentId:e.intent.intentId,executionId:auth.executionId,state:'RESERVED',updatedAt:this.now()});reserved=true;ensure();
 // Journal I/O is asynchronous: repeat authoritative READ immediately before
 // the possible effect, without changing the frozen bindings or authorization.
 const finalContext=this.access(await readContext());ensure();if(digest(finalContext)!==auth.bindingDigest){await this.journal.finish(auth.executionId,'FAILURE',this.now());reserved=false;return this.failure(e,'INVALIDATED','PRECONDITION_CHANGED');}
 e.state='EXECUTING';let rejectAbort!:(error:ToolError)=>void;const interrupted=new Promise<never>((_resolve,reject)=>{rejectAbort=reject;});const stop=()=>rejectAbort(new ToolError('EXECUTION_UNKNOWN'));controller.signal.addEventListener('abort',stop,{once:true});
 let proof;try{dispatched=true;proof=await Promise.race([this.simulator.execute(e.intent,controller.signal),interrupted]);}finally{controller.signal.removeEventListener('abort',stop);}ensure();e.state='VERIFYING';proofSchema.parse(proof);ensure();e.state='SUCCESS';e.result=resultSchema.parse({intentId:e.intent.intentId,executionId:auth.executionId,simulationOnly:true,execution:'ACKNOWLEDGED',verification:'VERIFIED',outcome:'CONFIRMED_SUCCESS',reason:'SIMULATED_EFFECT',evidence:'SIMULATED_MESSAGE_ACCEPTED'});
 // A verified effect is not erased by late cancellation or journal completion.
 await this.journal.finish(auth.executionId,'SUCCESS',this.now()).catch(()=>{});return e.result;
 }catch{if(terminal.has(e.state)&&e.result)return e.result;const result=dispatched?this.unknown(e,controller.signal.aborted||signal.aborted?'TIMEOUT':'DISPATCH_UNCERTAIN'):this.failure(e,'FAILURE',controller.signal.aborted||signal.aborted?'TIMEOUT':e.state==='DISPATCH_RESERVED'&&!reserved?'JOURNAL_UNAVAILABLE':'ACCESS_REVOKED');if(reserved)await this.journal.finish(auth.executionId,dispatched?'UNKNOWN':'FAILURE',this.now()).catch(()=>{});return result;
 }finally{e.controller=undefined;clearTimeout(timer);signal.removeEventListener('abort',abort);}}
 execute(intentId:string,signal:AbortSignal):Promise<ConsequentialResult>{const e=this.entry(intentId);if(e.draft||this.draftOnly)throw new ToolError('REJECTED');if(e.work)return e.work;if(e.result)return Promise.resolve(e.result);if(e.state!=='REVALIDATING'||!e.authorization)throw new ToolError('REJECTED');e.work=this.run(e,signal);return e.work;}
 // Only a trusted executor lifecycle hook grants execution. Model input contains
 // no confirmationId, executionId, origin, grant or approval boolean.
 simulationTool():ToolDefinition{if(this.draftOnly)throw new ToolError('REJECTED');return {id:'browser.simulateSendMessage',name:'browser_simulateSendMessage',description:'SIMULATION ONLY: no external effect.',integration:'browser',capability:'simulateSendMessage',permission:'SENSITIVE',schema:inputSchema,timeoutMs:18_000,prepare:(raw,signal)=>this.prepare(raw,signal),summarize:raw=>this.entry((raw as {intentId:string}).intentId).intent.summary,
 confirmationLifecycle:{pending:(raw,id,expires)=>this.pending((raw as {intentId:string}).intentId,id,expires),decided:(raw,id,approved)=>this.decided((raw as {intentId:string}).intentId,id,approved),invalidated:(raw,reason)=>{const e=this.entry((raw as {intentId:string}).intentId);if(!terminal.has(e.state))this.failure(e,reason==='expired'?'EXPIRED':'CANCELLED',reason==='expired'?'EXPIRED':'CANCELLED');}},execute:(raw,signal)=>this.execute((raw as {intentId:string}).intentId,signal)};}
}
