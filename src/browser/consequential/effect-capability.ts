import { createHash,randomUUID } from 'node:crypto';
import { z } from 'zod';
import { effectCapabilitySchema,effectPhaseSchema,effectStateSchema,intentSchema } from './contracts.js';
import type { EffectCapability,EffectPhase,EffectState,FrozenIntent } from './contracts.js';
import { PrivateExecutionJournal } from './journal.js';
import type { JournalRow } from './journal.js';
import { ToolError } from '../../tools/types.js';

const uuid=z.string().uuid();
const bindingSchema=z.object({manualRequestId:uuid,selectionId:uuid}).strict();
type Entry={intent:FrozenIntent;state:EffectState;capability?:EffectCapability};
const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
const freeze=<T>(value:T):T=>{if(value&&typeof value==='object'){for(const item of Object.values(value))freeze(item);Object.freeze(value);}return value;};

// Backend-only authority for future effects. It is deliberately not wired to
// Tool Registry or the extension in B.1, so no capability can cause an effect.
export class ConsequentialEffectAuthority {
 private readonly entries=new Map<string,Entry>();
 private readonly capabilities=new Map<string,{value:EffectCapability;state:'ISSUED'|'CONSUMED'|'INVALIDATED'}>();
 constructor(private readonly journal:PrivateExecutionJournal,private readonly now=Date.now) {}
 freezeIntent(raw:FrozenIntent):EffectState {
  const intent=freeze(intentSchema.parse(raw)) as FrozenIntent;
  if(intent.recipient.uniqueness!=='USER_SELECTED'||this.entries.has(intent.intentId))throw new ToolError('REJECTED');
  this.entries.set(intent.intentId,{intent,state:'DRAFT_FROZEN'});return 'DRAFT_FROZEN';
 }
 requestConfirmation(intentId:string,phase:EffectPhase):EffectState {
  const entry=this.entry(intentId);effectPhaseSchema.parse(phase);this.live(entry);
  if(phase==='WRITE_DRAFT'&&entry.state==='DRAFT_FROZEN')entry.state='WAITING_WRITE_CONFIRMATION';
  else if(phase==='SEND_MESSAGE'&&entry.state==='DRAFT_WRITTEN')entry.state='WAITING_SEND_CONFIRMATION';
  else throw new ToolError('REJECTED');return entry.state;
 }
 authorize(intentId:string,phase:EffectPhase,confirmationId:string,rawBinding:unknown,ttlMs=15_000):EffectCapability {
  const entry=this.entry(intentId),binding=bindingSchema.parse(rawBinding);this.live(entry);uuid.parse(confirmationId);
  const expected=phase==='WRITE_DRAFT'?'WAITING_WRITE_CONFIRMATION':'WAITING_SEND_CONFIRMATION';if(entry.state!==expected)throw new ToolError('REJECTED');
  if(entry.intent.recipient.evidenceId!==binding.selectionId||!Number.isInteger(ttlMs)||ttlMs<1||ttlMs>60_000)throw new ToolError('REJECTED');
  const issuedAt=this.now(),capability=freeze(effectCapabilitySchema.parse({intentId,executionId:randomUUID(),confirmationId,phase,assurance:'USER_SELECTED',backendSessionId:entry.intent.backendSessionId,taskId:entry.intent.taskId,admissionId:entry.intent.admissionId,connectionEpoch:entry.intent.connectionEpoch,origin:entry.intent.origin,scopeId:entry.intent.scopeId,tabId:entry.intent.tabId,documentId:entry.intent.documentId,manualRequestId:binding.manualRequestId,selectionId:binding.selectionId,contentDigest:digest(entry.intent.content.text),issuedAt,expiresAt:Math.min(entry.intent.expiresAt,issuedAt+ttlMs),nonce:randomUUID()}));
  if(capability.expiresAt<=issuedAt)throw new ToolError('EXPIRED');entry.capability=capability;entry.state=phase==='WRITE_DRAFT'?'WRITE_REVALIDATING':'SEND_REVALIDATING';this.capabilities.set(capability.nonce,{value:capability,state:'ISSUED'});return capability;
 }
 async reserve(raw:unknown):Promise<EffectCapability> {
  const capability=effectCapabilitySchema.parse(raw),stored=this.capabilities.get(capability.nonce),entry=this.entry(capability.intentId);this.live(entry);
  if(capability.expiresAt<=this.now()){if(stored)stored.state='INVALIDATED';entry.state='EXPIRED';throw new ToolError('EXPIRED');}
  if(!stored||stored.state!=='ISSUED'||JSON.stringify(stored.value)!==JSON.stringify(capability)||entry.capability?.nonce!==capability.nonce)throw new ToolError('REJECTED');
  const expected=capability.phase==='WRITE_DRAFT'?'WRITE_REVALIDATING':'SEND_REVALIDATING';if(entry.state!==expected)throw new ToolError('REJECTED');
  stored.state='CONSUMED';entry.state=capability.phase==='WRITE_DRAFT'?'WRITE_RESERVED':'SEND_RESERVED';
  try{await this.journal.reserve({intentId:capability.intentId,executionId:capability.executionId,phase:capability.phase,state:'RESERVED',updatedAt:this.now()});return capability;}
  catch(error){entry.state='FAILURE';throw error;}
 }
 begin(executionId:string):EffectState {const entry=this.execution(executionId);if(entry.state==='WRITE_RESERVED')entry.state='WRITING';else if(entry.state==='SEND_RESERVED')entry.state='SENDING';else throw new ToolError('REJECTED');return entry.state;}
 async finish(executionId:string,result:'SUCCESS'|'FAILURE'|'UNKNOWN'):Promise<EffectState> {
  const entry=this.execution(executionId),phase=entry.capability!.phase;if(!['WRITING','SENDING'].includes(entry.state))throw new ToolError('REJECTED');
  if(phase==='SEND_MESSAGE'&&result==='SUCCESS')throw new ToolError('REJECTED');
  await this.journal.finish(executionId,result,this.now());entry.state=result==='UNKNOWN'?'UNKNOWN':result==='FAILURE'?'FAILURE':phase==='WRITE_DRAFT'?'DRAFT_WRITTEN':'SUCCESS';return entry.state;
 }
 dispatched(executionId:string):EffectState {const entry=this.execution(executionId);if(entry.capability?.phase!=='SEND_MESSAGE'||entry.state!=='SENDING')throw new ToolError('REJECTED');entry.state='VERIFYING';return entry.state;}
 async verify(executionId:string,result:'VERIFIED'|'INCONCLUSIVE'):Promise<EffectState> {const entry=this.execution(executionId);if(entry.state!=='VERIFYING')throw new ToolError('REJECTED');const state=result==='VERIFIED'?'SUCCESS':'UNKNOWN';await this.journal.finish(executionId,state,this.now());entry.state=state;return state;}
 invalidate(intentId:string):void {const entry=this.entry(intentId);if(['SUCCESS','FAILURE','UNKNOWN','EXPIRED','INVALIDATED'].includes(entry.state))return;entry.state='INVALIDATED';if(entry.capability)this.capabilities.get(entry.capability.nonce)!.state='INVALIDATED';}
 state(intentId:string):EffectState {const entry=this.entry(intentId);if(entry.intent.expiresAt<=this.now()&&!['SUCCESS','FAILURE','UNKNOWN','EXPIRED','INVALIDATED'].includes(entry.state)){entry.state='EXPIRED';if(entry.capability)this.capabilities.get(entry.capability.nonce)!.state='INVALIDATED';}return effectStateSchema.parse(entry.state);}
 recover():Promise<JournalRow[]> {this.capabilities.clear();for(const entry of this.entries.values())if(!['SUCCESS','FAILURE','UNKNOWN'].includes(entry.state))entry.state='INVALIDATED';return this.journal.recover();}
 has(intentId:string):boolean{return this.entries.has(intentId);}
 private live(entry:Entry):void {if(this.state(entry.intent.intentId)==='EXPIRED')throw new ToolError('EXPIRED');if(['FAILURE','UNKNOWN','INVALIDATED','SUCCESS'].includes(entry.state))throw new ToolError(entry.state==='UNKNOWN'?'EXECUTION_UNKNOWN':'REJECTED');}
 private entry(intentId:string):Entry {const entry=this.entries.get(intentId);if(!entry)throw new ToolError('REJECTED');return entry;}
 private execution(executionId:string):Entry {const entry=[...this.entries.values()].find(row=>row.capability?.executionId===executionId);if(!entry)throw new ToolError('REJECTED');return entry;}
}
