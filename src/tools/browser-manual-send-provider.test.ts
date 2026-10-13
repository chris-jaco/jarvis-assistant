import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AttachedChromeProvider } from '../browser/attached/provider.js';
import type { BrowserTransport } from '../browser/attached/transport.js';
import type { Reply } from '../browser/attached/protocol.js';
import { PrivateExecutionJournal } from '../browser/consequential/journal.js';
import { canEndTask } from '../browser/task-lifecycle.js';
import { BrowserAdapter } from './adapters/browser.js';
import { ToolExecutor } from './execution.js';
import { ToolRegistry } from './registry.js';

test('attached provider exposes private drafts but no send tool or dispatch',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'atlas-send-provider-'));const journal=new PrivateExecutionJournal(join(dir,'journal.json'));
 const session=randomUUID(),connection=randomUUID(),epoch=randomUUID(),scopeId=randomUUID(),tabId=randomUUID(),documentId=randomUUID(),selectionId=randomUUID(),manualRequestId=randomUUID(),admissionId=randomUUID();
 const tab={id:tabId,scopeId,title:'WhatsApp Web',url:'https://web.whatsapp.com/',active:true,expiresAt:Date.now()+120_000,state:'ACTIVE' as const};
 let dispatches=0,selected=false;let listener:((connection:string,event:any)=>void)|undefined;const operations:string[]=[];
 const transport:BrowserTransport={epoch,connections:()=>[connection],subscribe:next=>{listener=next;return()=>{listener=undefined;}},close:()=>{},request:async(_connection,request):Promise<Reply>=>{
  operations.push(request.operation);
  if(request.operation==='listAuthorizedTabs')return {outcome:'OK',data:[tab]};
  if(request.operation==='observe')return {outcome:'OK',data:{tabId,scopeId,documentId,snapshotId:randomUUID(),expiresAt:Date.now()+15_000,url:tab.url,title:tab.title,elements:[],truncated:false,conversationEvidence:{provenance:{adapter:'whatsapp',version:1},state:'INSUFFICIENT_EVIDENCE',reason:'STRUCTURE_ONLY',conversationKind:'NOT_VERIFIED',truncated:false,activePanelCandidate:true,header:true,composer:true,composerEnabled:true,contactCandidates:0,contactPanel:'NOT_VERIFIED',phoneEvidence:'NOT_VERIFIED',contactAssociation:'NOT_VERIFIED',identity:'NOT_VERIFIED',phoneMatch:'NOT_VERIFIED',handles:{conversation:randomUUID(),header:randomUUID(),composer:randomUUID()},binding:{tabId,scopeId,documentId,epoch},trust:'UNTRUSTED_PAGE_EVIDENCE'},...(selected?{manualSelection:{selectionId,manualRequestId,admissionId,taskId:request.taskId,scopeId,tabId,documentId,epoch,expiresAt:Date.now()+120_000,assurance:'USER_SELECTED' as const}}:{})}};
  if(request.operation==='requestManualSelection')return {outcome:'REQUIRES_USER_INTERACTION',handoffId:manualRequestId,reason:'CONVERSATION_SELECTION'};
  if(request.operation==='writeSelectedDraft'){dispatches++;assert.equal(request.args.text,'Exact message');return {outcome:'OK',data:{draftState:'WRITTEN_VERIFIED'}};}
  if(request.operation==='sendSelectedMessage'){dispatches++;assert.equal(request.args.selectionId,selectionId);assert.equal(request.args.text,'Exact message');return {outcome:'OK',data:{sendState:'DISPATCHED_UNVERIFIED',draftVisible:false}};}
  return {outcome:'ERROR',code:'REJECTED'};
 }};
 const provider=new AttachedChromeProvider(transport,true,undefined,undefined,undefined,undefined,undefined,journal),adapter=new BrowserAdapter(provider),registry=new ToolRegistry();registry.add(adapter);const executor=new ToolExecutor(registry);
 try{
  await adapter.inSession(session,async()=>{await adapter.admitGoal(admissionId,'Write a WhatsApp draft message and leave it as a draft');await provider.listTabs(new AbortController().signal);await provider.requestManualSelection(new AbortController().signal);selected=true;listener?.(connection,{protocol:'atlas.browser',version:1,kind:'event',connectionEpoch:epoch,backendSessionId:session,event:'manualSelectionResolved',scopeId,manualRequestId,manualStatus:'SELECTED',taskId:provider.state(session).taskId,admissionId});provider.acknowledge(provider.state(session).continuation!);
   const prepared=await executor.invoke(randomUUID(),'browser.prepareDraft',{recipientHint:'Sofía',text:'Exact message'});assert.equal(prepared.status,'success');if(prepared.status!=='success')throw new Error();const draft=prepared.data as {intent:{intentId:string;recipient:{uniqueness:string}};confirmationEnabled:boolean;executionEnabled:boolean};assert.equal(draft.intent.recipient.uniqueness,'USER_SELECTED');assert.equal(draft.confirmationEnabled,false);assert.equal(draft.executionEnabled,false);
   const writePending=await executor.invoke(randomUUID(),'browser.writeDraft',{intentId:draft.intent.intentId});assert.equal(writePending.status,'pending');if(writePending.status!=='pending')throw new Error();
   assert.equal((await provider.endTask(new AbortController().signal,{reason:'COMPLETED'},true) as {outcome:string}).outcome,'END_TASK_REJECTED');assert.equal(dispatches,0);
   const written=await executor.decide(writePending.confirmationId,true);assert.equal(written.status,'success');assert.equal(dispatches,1);assert.equal((written as {data:{status:string}}).data.status,'DRAFT_WRITTEN');
   assert.equal(registry.resolve('browser.sendMessage'),undefined);
   const denied=await executor.invoke(randomUUID(),'browser.sendMessage',{intentId:draft.intent.intentId});assert.equal(denied.status,'error');
   assert.equal(dispatches,1);
  });
  assert.deepEqual(operations.filter(x=>x==='sendSelectedMessage'),[]);
  assert.equal((await journal.recover()).filter(row=>row.phase==='WRITE_DRAFT').length,1);
 }finally{executor.close();await provider.close();await rm(dir,{recursive:true,force:true});}
});

test('an unverified consequential dispatch cannot close as COMPLETED',()=>{
 const facts={intent:'ACTION_REQUIRED' as const,readObtained:true,progress:true,pending:false,unknown:false,fresh:true,verificationRequired:false,verified:false,verificationExhausted:false,cancelled:false,terminal:false,recoveryExhausted:false,consequentialUnverified:true};
 assert.equal(canEndTask({reason:'COMPLETED'},facts),false);
 assert.equal(canEndTask({reason:'INCONCLUSIVE'},facts),true);
 assert.equal(canEndTask({reason:'INCONCLUSIVE'},{...facts,unknown:true,consequentialUnverified:false,consequentialUnknown:true}),true);
 assert.equal(canEndTask({reason:'INCONCLUSIVE'},{...facts,unknown:true,consequentialUnverified:false,consequentialUnknown:false}),false);
 assert.equal(canEndTask({reason:'COMPLETED'},{...facts,consequentialUnverified:false}),true);
});
