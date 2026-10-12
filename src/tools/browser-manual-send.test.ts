import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { ConsequentialFoundation } from '../browser/consequential/foundation.js';
import { PrivateExecutionJournal } from '../browser/consequential/journal.js';
import type { DraftContext } from '../browser/consequential/semantic.js';
import { ToolExecutor } from './execution.js';
import { ToolRegistry } from './registry.js';
import type { ToolDefinition } from './types.js';

async function fixture(effect:(_signal:AbortSignal)=>Promise<{sendState:'NOT_SENT'|'DISPATCHED_UNVERIFIED';draftVisible:boolean}>=async()=>({sendState:'DISPATCHED_UNVERIFIED',draftVisible:false})){
 const dir=await mkdtemp(join(tmpdir(),'atlas-manual-send-'));const journal=new PrivateExecutionJournal(join(dir,'journal.json'));const now=Date.now();
 const selection={selectionId:randomUUID(),scopeId:randomUUID(),tabId:randomUUID(),documentId:randomUUID(),epoch:randomUUID(),expiresAt:now+120_000,assurance:'USER_SELECTED' as const};
 let context:DraftContext={backendSessionId:randomUUID(),taskId:randomUUID(),admissionId:randomUUID(),connectionEpoch:selection.epoch,origin:'https://web.whatsapp.com',scopeId:selection.scopeId,tabId:selection.tabId,documentId:selection.documentId,snapshotId:randomUUID(),snapshotExpiresAt:now+20_000,grantExpiresAt:now+120_000,chromePermission:true,siteAuthorized:true,grantValid:true,requestedIdentifiers:[],semantic:{origin:'https://web.whatsapp.com',conversations:[],truncated:false,trust:'UNTRUSTED_PAGE_EVIDENCE'},manualSelection:selection};
 const foundation=ConsequentialFoundation.drafts(context.backendSessionId,Date.now,journal);let dispatches=0;
 await foundation.enableManualSend(async()=>context,async(_intent,signal)=>{dispatches++;return effect(signal);});
 const draft=foundation.prepareDraft({recipientHint:'Test recipient',text:'Exact test message'},context,new AbortController().signal);
 if(!('intent'in draft))throw new Error('draft not frozen');
 const registry=new ToolRegistry(),schema=z.object({intentId:z.string().uuid()}).strict();
 const tool:ToolDefinition={id:'browser.testManualSend',name:'browser_testManualSend',integration:'browser',capability:'sendMessage',description:'Test only',permission:'SENSITIVE',confirm:true,schema,
  prepare:async(raw,signal)=>foundation.prepareManual((raw as {intentId:string}).intentId,signal),summarize:raw=>(raw as {summary:string}).summary,
  confirmationLifecycle:{pending:(raw,id,expires)=>foundation.pendingManual((raw as {intentId:string}).intentId,id,expires),decided:(raw,id,approved)=>foundation.decidedManual((raw as {intentId:string}).intentId,id,approved),invalidated:raw=>foundation.invalidate((raw as {intentId:string}).intentId)},
  execute:(raw,signal)=>foundation.executeManual((raw as {intentId:string}).intentId,signal)};
 registry.register(tool);const executor=new ToolExecutor(registry);
 return {foundation,executor,journal,draft,context:()=>context,change:(next:DraftContext)=>{context=next;},dispatches:()=>dispatches,close:async()=>{executor.close();await rm(dir,{recursive:true,force:true});}};
}

test('shared confirmation approves one frozen user-selected intent and never dispatches twice',async()=>{
 const f=await fixture();try{
  const pending=await f.executor.invoke(randomUUID(),'browser.testManualSend',{intentId:f.draft.intent.intentId});assert.equal(pending.status,'pending');if(pending.status!=='pending')throw new Error();
  assert.match(pending.summary,/conversación que seleccionaste/);
  const [first,second]=await Promise.all([f.executor.decide(pending.confirmationId,true),f.executor.decide(pending.confirmationId,true)]);
  assert.deepEqual([first.status,second.status].sort(),['error','success']);assert.equal(f.dispatches(),1);
  if(first.status==='success')assert.equal((first.data as {outcome:string}).outcome,'ACTION_EXECUTED_UNVERIFIED');
  assert.equal((await f.foundation.executeManual(f.draft.intent.intentId,new AbortController().signal)).outcome,'ACTION_EXECUTED_UNVERIFIED');assert.equal(f.dispatches(),1);
  const rows=await f.journal.recover();assert.equal(rows.length,1);assert.equal(rows[0]!.state,'UNKNOWN');
  const restarted=ConsequentialFoundation.drafts(f.context().backendSessionId,Date.now,f.journal);
  await restarted.enableManualSend(async()=>f.context(),async()=>{throw new Error('must not dispatch');});
  assert.throws(()=>restarted.prepareDraft({recipientHint:'Test recipient',text:'Exact test message'},f.context(),new AbortController().signal));
 }finally{await f.close();}
});

test('rejection and material context change never dispatch',async()=>{
 const rejected=await fixture();try{const pending=await rejected.executor.invoke(randomUUID(),'browser.testManualSend',{intentId:rejected.draft.intent.intentId});assert.equal(pending.status,'pending');if(pending.status==='pending')await rejected.executor.decide(pending.confirmationId,false);assert.equal(rejected.dispatches(),0);}finally{await rejected.close();}
 const changed=await fixture();try{const pending=await changed.executor.invoke(randomUUID(),'browser.testManualSend',{intentId:changed.draft.intent.intentId});assert.equal(pending.status,'pending');changed.change({...changed.context(),manualSelection:{...changed.context().manualSelection!,selectionId:randomUUID()}});if(pending.status==='pending'){const result=await changed.executor.decide(pending.confirmationId,true);assert.equal(result.status,'success');if(result.status==='success')assert.equal((result.data as {outcome:string}).outcome,'ACTION_FAILED');}assert.equal(changed.dispatches(),0);}finally{await changed.close();}
});

test('no Send control is a known failure; uncertain dispatch is never retried',async()=>{
 const noControl=await fixture(async()=>({sendState:'NOT_SENT',draftVisible:true}));
 try{const pending=await noControl.executor.invoke(randomUUID(),'browser.testManualSend',{intentId:noControl.draft.intent.intentId});assert.equal(pending.status,'pending');if(pending.status==='pending'){const result=await noControl.executor.decide(pending.confirmationId,true);assert.equal(result.status,'success');if(result.status==='success'){assert.equal((result.data as {outcome:string}).outcome,'ACTION_FAILED');assert.equal((result.data as {draftVisible:boolean}).draftVisible,true);}}assert.equal(noControl.dispatches(),1);assert.equal((await noControl.journal.recover())[0]!.state,'FAILURE');}finally{await noControl.close();}
 const uncertain=await fixture(async()=>{throw new Error('transport lost after possible effect');});
 try{const pending=await uncertain.executor.invoke(randomUUID(),'browser.testManualSend',{intentId:uncertain.draft.intent.intentId});assert.equal(pending.status,'pending');if(pending.status==='pending'){const result=await uncertain.executor.decide(pending.confirmationId,true);assert.equal(result.status,'success');if(result.status==='success')assert.equal((result.data as {outcome:string}).outcome,'EXECUTION_UNKNOWN');}assert.equal(uncertain.dispatches(),1);assert.equal((await uncertain.foundation.executeManual(uncertain.draft.intent.intentId,new AbortController().signal)).outcome,'EXECUTION_UNKNOWN');assert.equal(uncertain.dispatches(),1);assert.equal((await uncertain.journal.recover())[0]!.state,'UNKNOWN');}finally{await uncertain.close();}
});

test('cancellation after possible dispatch remains UNKNOWN and never retries',async()=>{
 let started!:()=>void;const dispatched=new Promise<void>(resolve=>{started=resolve;});
 const f=await fixture(signal=>new Promise((_resolve,reject)=>{started();signal.addEventListener('abort',()=>reject(new Error('cancelled after dispatch')),{once:true});}));
 try{
  const fresh=await f.foundation.prepareManual(f.draft.intent.intentId,new AbortController().signal);
  const pendingId=randomUUID();f.foundation.pendingManual(fresh.intentId,pendingId,Date.now()+60_000);
  const confirmation=f.foundation.state(fresh.intentId);assert.equal(confirmation.state,'WAITING_CONFIRMATION');
  // The shared executor normally supplies this ID; exercise post-dispatch abort.
  f.foundation.decidedManual(fresh.intentId,pendingId,true);
  const controller=new AbortController(),result=f.foundation.executeManual(fresh.intentId,controller.signal);
  await dispatched;controller.abort();
  assert.equal((await result).outcome,'EXECUTION_UNKNOWN');assert.equal(f.dispatches(),1);
  assert.equal((await f.foundation.executeManual(fresh.intentId,new AbortController().signal)).outcome,'EXECUTION_UNKNOWN');assert.equal(f.dispatches(),1);
 }finally{await f.close();}
});

test('invalidation during dispatch keeps the durable journal UNKNOWN',async()=>{
 let started!:()=>void;const dispatched=new Promise<void>(resolve=>{started=resolve;});
 const f=await fixture(signal=>new Promise((_resolve,reject)=>{started();signal.addEventListener('abort',()=>reject(new Error('invalidated after dispatch')),{once:true});}));
 try{
  const id=f.draft.intent.intentId;
  await f.foundation.prepareManual(id,new AbortController().signal);
  const confirmationId=randomUUID();f.foundation.pendingManual(id,confirmationId,Date.now()+60_000);f.foundation.decidedManual(id,confirmationId,true);
  const result=f.foundation.executeManual(id,new AbortController().signal);
  await dispatched;f.foundation.invalidate(id,'ACCESS_REVOKED');
  assert.equal((await result).outcome,'EXECUTION_UNKNOWN');
  assert.equal((await f.journal.recover())[0]!.state,'UNKNOWN');
  assert.equal(f.dispatches(),1);
 }finally{await f.close();}
});
