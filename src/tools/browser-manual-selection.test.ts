import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { JSDOM } from 'jsdom';
import { ContentEngine } from '../../extension/src/content-engine.js';
import { ExtensionController } from '../../extension/src/controller.js';
import type { Surface } from '../../extension/src/controller.js';
import { ConsequentialFoundation } from '../browser/consequential/foundation.js';
import type { DraftContext } from '../browser/consequential/semantic.js';
import { AttachedChromeProvider } from '../browser/attached/provider.js';
import type { BrowserTransport } from '../browser/attached/transport.js';
import type { Reply } from '../browser/attached/protocol.js';
import { BrowserAdapter } from './adapters/browser.js';
import { BrowserContinuation } from '../provider/browser-continuation.js';

const source='<main id="main" data-testid="conversation-panel-wrapper"><header data-testid="conversation-header">PERSONAL_NAME</header><footer><div data-testid="conversation-compose-box-input" role="textbox" contenteditable="true"></div><button>Send</button></footer></main>';
function fixture(html=source){
 const dom=new JSDOM(html,{url:'https://web.whatsapp.com/',pretendToBeVisual:true}),win=dom.window;
 win.HTMLElement.prototype.checkVisibility=function(){return !this.closest('[hidden],[aria-hidden="true"]');};
 win.HTMLElement.prototype.getBoundingClientRect=function(){const x=[...win.document.querySelectorAll('*')].indexOf(this)*8;return {left:x,right:x+6,top:0,bottom:6,width:6,height:6,x,y:0,toJSON(){}};};
 win.document.elementFromPoint=x=>[...win.document.querySelectorAll('*')].find(n=>{const r=n.getBoundingClientRect();return x>=r.left&&x<=r.right;})??null;
 const access={scopeId:randomUUID(),tabId:randomUUID(),session:randomUUID(),epoch:randomUUID(),origin:'https://web.whatsapp.com',expiresAt:Date.now()+60_000},documentId=randomUUID();let first=true;
 const engine=new ContentEngine(win as unknown as Window & typeof globalThis,Date.now,()=>{if(first){first=false;return documentId;}return randomUUID();},async()=>{});engine.initialize(access);
 const manualRequestId=randomUUID(),taskId=randomUUID(),admissionId=randomUUID();
 return {win,engine,access,documentId,manualRequestId,taskId,admissionId,select:()=>engine.selectConversation(access,manualRequestId,taskId,admissionId,documentId),close:()=>{engine.destroy();win.close();}};
}

test('a popup selection binds only the current conversation and does not assert verified identity',async()=>{
 const f=fixture();try{
  assert.equal(f.select(),true);
  const observed=await f.engine.run('observe',{scopeId:f.access.scopeId,tabId:f.access.tabId},Date.now()+5000,{session:f.access.session,epoch:f.access.epoch});
  assert.equal(observed.outcome,'OK');if(observed.outcome!=='OK'||!('manualSelection'in observed.data))throw new Error('missing observation');
  assert.equal(observed.data.manualSelection?.assurance,'USER_SELECTED');
  assert.equal(observed.data.conversationEvidence?.identity,'NOT_VERIFIED');
  assert.equal(JSON.stringify(observed.data).includes('PERSONAL_NAME'),false);
  f.win.document.querySelector('header')!.textContent='OTHER_PERSON';
  const changed=await f.engine.run('observe',{scopeId:f.access.scopeId,tabId:f.access.tabId},Date.now()+5000,{session:f.access.session,epoch:f.access.epoch});
  assert.equal(changed.outcome,'OK');if(changed.outcome!=='OK'||!('elements'in changed.data))throw new Error();
  assert.equal(changed.data.manualSelection,undefined);
 }finally{f.close();}
});

test('selection expires on document change and cannot be created without usable conversation',async()=>{
 const f=fixture();try{assert.equal(f.select(),true);f.engine.documentChanged();const result=await f.engine.run('observe',{scopeId:f.access.scopeId,tabId:f.access.tabId},Date.now()+5000,{session:f.access.session,epoch:f.access.epoch});assert.equal(result.outcome,'OK');if(result.outcome==='OK'&&'manualSelection'in result.data)assert.equal(result.data.manualSelection,undefined);}finally{f.close();}
 const group=fixture(source.replace('<header data-testid="conversation-header"','<header aria-label="Group info" data-testid="conversation-header"'));
 try{assert.equal(group.select(),false);}finally{group.close();}
});

test('terminal request tombstone prevents late or replayed selection evidence',async()=>{
 const f=fixture();try{
  f.engine.clearManualSelection(f.manualRequestId);
  assert.equal(f.select(),false,'a request cleared before delayed delivery cannot publish evidence');
  const nextRequest=randomUUID();
  assert.equal(f.engine.selectConversation(f.access,nextRequest,f.taskId,f.admissionId,f.documentId),true);
  f.engine.clearManualSelection(f.manualRequestId);
  let observed=await f.engine.run('observe',{scopeId:f.access.scopeId,tabId:f.access.tabId},Date.now()+5000,{session:f.access.session,epoch:f.access.epoch});
  assert.equal(observed.outcome,'OK');if(observed.outcome!=='OK'||!('manualSelection'in observed.data))throw new Error();assert.equal(observed.data.manualSelection?.manualRequestId,nextRequest,'cleanup is request-scoped');
  f.engine.clearManualSelection(nextRequest);
  observed=await f.engine.run('observe',{scopeId:f.access.scopeId,tabId:f.access.tabId},Date.now()+5000,{session:f.access.session,epoch:f.access.epoch});
  assert.equal(observed.outcome,'OK');if(observed.outcome==='OK'&&'manualSelection'in observed.data)assert.equal(observed.data.manualSelection,undefined);
 }finally{f.close();}
});

test('user selection yields a private draft with distinct assurance and material change invalidates it',()=>{
 const now=Date.now(),id=randomUUID(),taskId=randomUUID(),admissionId=randomUUID(),selection={selectionId:id,manualRequestId:randomUUID(),admissionId,taskId,scopeId:randomUUID(),tabId:randomUUID(),documentId:randomUUID(),epoch:randomUUID(),expiresAt:now+50_000,assurance:'USER_SELECTED' as const};
 const context:DraftContext={backendSessionId:randomUUID(),taskId,admissionId,connectionEpoch:selection.epoch,origin:'https://web.whatsapp.com',scopeId:selection.scopeId,tabId:selection.tabId,documentId:selection.documentId,snapshotId:randomUUID(),snapshotExpiresAt:now+15_000,grantExpiresAt:now+60_000,chromePermission:true,siteAuthorized:true,grantValid:true,requestedIdentifiers:[],semantic:{origin:'https://web.whatsapp.com',conversations:[],truncated:false,trust:'UNTRUSTED_PAGE_EVIDENCE'},manualSelection:selection};
 const foundation=ConsequentialFoundation.drafts(context.backendSessionId),signal=new AbortController().signal;
 const result=foundation.prepareDraft({recipientHint:'Sofía',text:'Llego a las ocho'},context,signal);
 assert.equal(result.status,'FROZEN');if(!('intent'in result))throw new Error();
 assert.equal(result.intent.recipient.uniqueness,'USER_SELECTED');assert.equal(result.confirmationEnabled,false);assert.equal(result.executionEnabled,false);
 assert.ok(result.intent.expiresAt>context.snapshotExpiresAt,'voice confirmation survives the preparing snapshot TTL');
 assert.equal(foundation.reviewDraft(result.intent.intentId,{...context,snapshotId:randomUUID()}).status,'FROZEN');
 assert.equal(foundation.reviewDraft(result.intent.intentId,{...context,manualSelection:{...selection,selectionId:randomUUID()}}).status,'INVALIDATED');
 assert.throws(()=>foundation.execute(result.intent.intentId,signal));
});

test('stored private draft remains frozen only through its TTL and never revives after invalidation',()=>{
 let now=Date.now();const taskId=randomUUID(),admissionId=randomUUID(),selection={selectionId:randomUUID(),manualRequestId:randomUUID(),admissionId,taskId,scopeId:randomUUID(),tabId:randomUUID(),documentId:randomUUID(),epoch:randomUUID(),expiresAt:now+50_000,assurance:'USER_SELECTED' as const};
 const context:DraftContext={backendSessionId:randomUUID(),taskId,admissionId,connectionEpoch:selection.epoch,origin:'https://web.whatsapp.com',scopeId:selection.scopeId,tabId:selection.tabId,documentId:selection.documentId,snapshotId:randomUUID(),snapshotExpiresAt:now+15_000,grantExpiresAt:now+60_000,chromePermission:true,siteAuthorized:true,grantValid:true,requestedIdentifiers:[],semantic:{origin:'https://web.whatsapp.com',conversations:[],truncated:false,trust:'UNTRUSTED_PAGE_EVIDENCE'},manualSelection:selection};
 const foundation=ConsequentialFoundation.drafts(context.backendSessionId,()=>now),draft:any=foundation.prepareDraft({recipientHint:'Selección manual',text:'Texto privado'},context,new AbortController().signal);assert.equal(foundation.reviewStoredDraft(draft.intent.intentId).status,'FROZEN');
 foundation.invalidateDrafts();assert.equal(foundation.reviewStoredDraft(draft.intent.intentId).status,'INVALIDATED');
 const expiringContext={...context,backendSessionId:randomUUID()},expiringFoundation=ConsequentialFoundation.drafts(expiringContext.backendSessionId,()=>now);const expiringDraft:any=expiringFoundation.prepareDraft({recipientHint:'Selección manual',text:'Texto privado'},expiringContext,new AbortController().signal);
 now=expiringDraft.intent.expiresAt+1;assert.equal(expiringFoundation.reviewStoredDraft(expiringDraft.intent.intentId).status,'EXPIRED');
});

test('direct content command never writes or clicks Send for absent, false, invalid or true configuration',async()=>{
 const f=fixture(source.replace('<button>Send</button>','<button aria-label="Send">Send</button>'));
 try{
  const composer=f.win.document.querySelector('[data-testid="conversation-compose-box-input"]')!;
  let clicks=0,writes=0;f.win.document.querySelector('button')!.addEventListener('click',()=>{clicks++;});
  Object.defineProperty(f.win.document,'execCommand',{value:()=>{writes++;return true;}});
  assert.equal(f.select(),true);
  const observed=await f.engine.run('observe',{scopeId:f.access.scopeId,tabId:f.access.tabId},Date.now()+5000,{session:f.access.session,epoch:f.access.epoch});
  assert.equal(observed.outcome,'OK');if(observed.outcome!=='OK'||!('manualSelection'in observed.data)||!observed.data.manualSelection)throw new Error();
  const args={scopeId:f.access.scopeId,tabId:f.access.tabId,documentId:observed.data.documentId,selectionId:observed.data.manualSelection.selectionId,text:'One exact test message'};
  for(const configured of [undefined,'false','invalid','true']){
   const first=await f.engine.run('sendSelectedMessage',{...args,sendEnabled:configured},Date.now()+5000,{session:f.access.session,epoch:f.access.epoch});
   assert.equal(first.outcome,'ERROR');assert.equal(composer.textContent,'');assert.equal(clicks,0);assert.equal(writes,0);
  }
 }finally{f.close();}
});

test('generic type, press Enter and click cannot use a chat composer or Send control',async()=>{
 const f=fixture(source.replace('<button>Send</button>','<button aria-label="Send">Send</button>'));
 try{
  let writes=0,clicks=0;Object.defineProperty(f.win.document,'execCommand',{value:()=>{writes++;return true;}});
  f.win.document.querySelector('button')!.addEventListener('click',()=>clicks++);
  const observed=await f.engine.run('observe',{scopeId:f.access.scopeId,tabId:f.access.tabId},Date.now()+5000,{session:f.access.session,epoch:f.access.epoch});
  assert.equal(observed.outcome,'OK');if(observed.outcome!=='OK'||!('elements'in observed.data))throw new Error();
  const blocked=observed.data.elements.filter(item=>item.action==='blocked');assert.ok(blocked.length>0);
  for(const element of blocked){
   const binding={scopeId:f.access.scopeId,tabId:f.access.tabId,documentId:observed.data.documentId,snapshotId:observed.data.snapshotId,ref:element.ref};
   const result=await f.engine.run(element.role==='textbox'?'type':'click',element.role==='textbox'?{...binding,text:'Test',mode:'replace'}:binding,Date.now()+5000,{session:f.access.session,epoch:f.access.epoch});
   assert.notEqual(result.outcome,'OK');
   if(element.role==='textbox'){
    const pressed=await f.engine.run('press',{...binding,key:'Enter'},Date.now()+5000,{session:f.access.session,epoch:f.access.epoch});
    assert.notEqual(pressed.outcome,'OK');
   }
  }
  assert.equal(writes,0);assert.equal(clicks,0);
 }finally{f.close();}
});

test('changed header and missing explicit Send control prevent dispatch',async()=>{
 for(const withButton of [true,false]){
  const f=fixture(withButton?source.replace('<button>Send</button>','<button aria-label="Send">Send</button>'):source);
  try{
   const composer=f.win.document.querySelector('[data-testid="conversation-compose-box-input"]')!;let clicks=0;f.win.document.querySelector('button')!.addEventListener('click',()=>clicks++);
   Object.defineProperty(f.win.document,'execCommand',{value:(_command:string,_ui:boolean,text:string)=>{composer.textContent=text;return true;}});
   assert.equal(f.select(),true);
   const observed=await f.engine.run('observe',{scopeId:f.access.scopeId,tabId:f.access.tabId},Date.now()+5000,{session:f.access.session,epoch:f.access.epoch});
   assert.equal(observed.outcome,'OK');if(observed.outcome!=='OK'||!('manualSelection'in observed.data)||!observed.data.manualSelection)throw new Error();
   if(withButton)f.win.document.querySelector('header')!.textContent='DIFFERENT_PERSON';
   const result=await f.engine.run('sendSelectedMessage',{scopeId:f.access.scopeId,tabId:f.access.tabId,documentId:observed.data.documentId,selectionId:observed.data.manualSelection.selectionId,text:'Test'},Date.now()+5000,{session:f.access.session,epoch:f.access.epoch});
   assert.equal(clicks,0);
   assert.equal(result.outcome,'ERROR');assert.equal(composer.textContent,'');
  }finally{f.close();}
 }
});

test('popup selection requires the exact active authorized task tab and stops after revoke',async()=>{
 const epoch=randomUUID(),session=randomUUID(),task=randomUUID(),admissionId=randomUUID(),documentId=randomUUID();let url='https://web.whatsapp.com/',now=Date.now(),selections=0;
 const surface:Surface={current:async()=>({id:7,windowId:1,url,title:'Test'}),create:async()=>7,activate:async()=>{},navigate:async()=>{},history:async()=>{},invalidate:async()=>{},content:async()=>({outcome:'ERROR',code:'REJECTED'}),selectConversation:async()=>{selections++;return true;}};
 const controller=new ExtensionController(surface,()=>{},()=>now,randomUUID,{allows:async origin=>origin==='https://web.whatsapp.com',allowAlways:async()=>{}});
 await controller.reset({protocol:'atlas.browser',version:1,kind:'hello',connectionEpoch:epoch});
 const request={protocol:'atlas.browser',version:1,kind:'request',requestId:randomUUID(),backendSessionId:session,taskId:task,connectionEpoch:epoch,deadlineAt:now+10_000,operation:'requestTabAccess',args:{target:{kind:'current'},purpose:'Test',lifetime:'task'}};
 const reply=await controller.receive(request);assert.equal(reply.outcome,'OK');if(reply.outcome!=='OK'||!('scopeId'in reply.data))throw new Error();const scopeId=reply.data.scopeId;
 const pending=await controller.receive({...request,requestId:randomUUID(),operation:'requestManualSelection',args:{scopeId,tabId:(reply.data as {id:string}).id,documentId,admissionId}});
 assert.equal(pending.outcome,'REQUIRES_USER_INTERACTION');if(pending.outcome==='REQUIRES_USER_INTERACTION')assert.equal(pending.reason,'CONVERSATION_SELECTION');
 assert.equal(await controller.selectConversation(scopeId),true);assert.equal(selections,1);
 const direct=await controller.receive({...request,requestId:randomUUID(),operation:'sendSelectedMessage',args:{scopeId,tabId:(reply.data as {id:string}).id,documentId:randomUUID(),selectionId:randomUUID(),text:'Test'}});
 assert.equal(direct.outcome,'ERROR');if(direct.outcome==='ERROR')assert.equal(direct.code,'REJECTED');
 url='https://example.test/';await assert.rejects(controller.selectConversation(scopeId));assert.equal(selections,1);
 url='https://web.whatsapp.com/';await controller.revoke(scopeId);await assert.rejects(controller.selectConversation(scopeId));assert.equal(selections,1);
});

test('manual selection request is scoped, popup-only and resolves concurrently at most once',async()=>{
 const epoch=randomUUID(),session=randomUUID(),task=randomUUID(),admissionId=randomUUID(),documentId=randomUUID(),events:any[]=[];let now=Date.now(),selections=0,url='https://web.whatsapp.com/';
 const surface:Surface={current:async()=>({id:7,windowId:1,url,title:'Test'}),create:async()=>7,activate:async()=>{},navigate:async()=>{},history:async()=>{},invalidate:async()=>{},content:async()=>({outcome:'ERROR',code:'REJECTED'}),selectConversation:async(_tab,_grant,_epoch,_request,_task,actualAdmission,actualDocument)=>{assert.equal(actualAdmission,admissionId);assert.equal(actualDocument,documentId);selections++;await Promise.resolve();return true;}};
 const controller=new ExtensionController(surface,event=>events.push(event),()=>now,randomUUID,{allows:async origin=>origin==='https://web.whatsapp.com',allowAlways:async()=>{}});await controller.reset({protocol:'atlas.browser',version:1,kind:'hello',connectionEpoch:epoch});
 const base={protocol:'atlas.browser',version:1,kind:'request',backendSessionId:session,taskId:task,connectionEpoch:epoch,deadlineAt:now+10_000};
 const access:any=await controller.receive({...base,requestId:randomUUID(),operation:'requestTabAccess',args:{target:{kind:'current'},purpose:'Draft',lifetime:'task'}});assert.equal(access.outcome,'OK');const scopeId=access.data.scopeId,tabId=access.data.id;
 await assert.rejects(controller.selectConversation(scopeId));
 const raw={...base,requestId:randomUUID(),operation:'requestManualSelection',args:{scopeId,tabId,documentId,admissionId}};
 const pending:any=await controller.receive(raw);assert.equal(pending.reason,'CONVERSATION_SELECTION');assert.equal(controller.authorized()[0]!.manualSelectionPending,true);
 const replay:any=await controller.receive({...raw,requestId:randomUUID()});assert.equal(replay.handoffId,pending.handoffId);
 const concurrent=await Promise.allSettled([controller.selectConversation(scopeId),controller.selectConversation(scopeId)]);assert.equal(concurrent.filter(result=>result.status==='fulfilled'&&result.value).length,1);assert.equal(selections,1);
 const selected=events.filter(event=>event.event==='manualSelectionResolved');assert.equal(selected.length,1);assert.equal(selected[0].manualStatus,'SELECTED');assert.equal(selected[0].admissionId,admissionId);assert.equal(controller.authorized()[0]!.manualSelectionPending,undefined);
 const next:any=await controller.receive({...raw,requestId:randomUUID(),args:{scopeId,tabId,documentId:randomUUID(),admissionId}});assert.equal(next.reason,'CONVERSATION_SELECTION');controller.cancelManualSelection(scopeId);
 assert.equal(events.filter(event=>event.event==='manualSelectionResolved'&&event.manualStatus==='CANCELLED').length,1);await assert.rejects(async()=>controller.cancelManualSelection(scopeId));
 const expiring:any=await controller.receive({...raw,requestId:randomUUID(),args:{scopeId,tabId,documentId:randomUUID(),admissionId}});assert.equal(expiring.reason,'CONVERSATION_SELECTION');now+=5*60_000+1;controller.expire();assert.equal(events.filter(event=>event.event==='manualSelectionResolved'&&event.manualStatus==='EXPIRED').length,1);
 const changing:any=await controller.receive({...raw,requestId:randomUUID(),deadlineAt:now+10_000,args:{scopeId,tabId,documentId:randomUUID(),admissionId}});assert.equal(changing.reason,'CONVERSATION_SELECTION');await controller.documentChanged(7);assert.equal(events.filter(event=>event.event==='manualSelectionResolved'&&event.manualStatus==='INVALIDATED').length,1);
 const switching:any=await controller.receive({...raw,requestId:randomUUID(),deadlineAt:now+10_000,args:{scopeId,tabId,documentId:randomUUID(),admissionId}});assert.equal(switching.reason,'CONVERSATION_SELECTION');await controller.activeTabChanged(8,2);assert.equal(controller.authorized()[0]!.manualSelectionPending,true,'another Chrome window cannot invalidate this request');await controller.activeTabChanged(8,1);assert.equal(events.filter(event=>event.event==='manualSelectionResolved'&&event.manualStatus==='INVALIDATED').length,2);
 url='https://example.test/';await assert.rejects(controller.selectConversation(scopeId));
});

test('cancel, expiry and reconnect win against delayed selection publication exactly once',async()=>{
 for(const terminal of ['CANCELLED','EXPIRED','INVALIDATED'] as const){
  const epoch=randomUUID(),session=randomUUID(),task=randomUUID(),admissionId=randomUUID(),documentId=randomUUID(),events:any[]=[];let now=Date.now(),release!:()=>void,published:string|undefined;const gate=new Promise<void>(resolve=>{release=resolve;});
  const surface:Surface={current:async()=>({id:7,windowId:1,url:'https://web.whatsapp.com/',title:'Test'}),create:async()=>7,activate:async()=>{},navigate:async()=>{},history:async()=>{},invalidate:async()=>{published=undefined;},content:async()=>({outcome:'ERROR',code:'REJECTED'}),clearManualSelection:async(_tab,id)=>{if(published===id)published=undefined;},selectConversation:async(_tab,_grant,_epoch,id)=>{await gate;published=id;return true;}};
  const controller=new ExtensionController(surface,event=>events.push(event),()=>now,randomUUID,{allows:async()=>true,allowAlways:async()=>{}});await controller.reset({protocol:'atlas.browser',version:1,kind:'hello',connectionEpoch:epoch});
  const base={protocol:'atlas.browser',version:1,kind:'request',backendSessionId:session,taskId:task,connectionEpoch:epoch,deadlineAt:now+10_000};
  const access:any=await controller.receive({...base,requestId:randomUUID(),operation:'requestTabAccess',args:{target:{kind:'current'},purpose:'Draft',lifetime:'task'}}),scopeId=access.data.scopeId,tabId=access.data.id;
  const request:any=await controller.receive({...base,requestId:randomUUID(),operation:'requestManualSelection',args:{scopeId,tabId,documentId,admissionId}});const selecting=controller.selectConversation(scopeId);
  if(terminal==='CANCELLED')controller.cancelManualSelection(scopeId);else if(terminal==='EXPIRED'){now+=5*60_000+1;controller.expire();}else await controller.reset({protocol:'atlas.browser',version:1,kind:'hello',connectionEpoch:randomUUID()});
  release();assert.equal(await selecting,false);await Promise.resolve();assert.equal(published,undefined,'late content evidence is cleared after losing the race');
  const resolutions=events.filter(event=>event.event==='manualSelectionResolved'&&event.manualRequestId===request.handoffId);assert.equal(resolutions.length,terminal==='INVALIDATED'?0:1);if(resolutions.length)assert.equal(resolutions[0].manualStatus,terminal);
 }
});

test('manual resolution continuation is silent, single-use and distinguishes selection from identity',()=>{
 const taskId=randomUUID(),requestId=randomUUID(),ready=randomUUID(),messages:string[]=[];const receipts:any[]=[];
 const continuation=new BrowserContinuation(async()=>({}),message=>messages.push(message),undefined,undefined,receipt=>receipts.push(receipt));
 continuation.update({taskId,workflow:{outcome:'REQUIRES_USER_INTERACTION',handoffId:requestId,reason:'CONVERSATION_SELECTION'},ready:null,executionState:'WAITING_MANUAL',manualSelection:{status:'PENDING',requestId}},false);assert.equal(messages.length,0);
 const selected={taskId,workflow:null,ready,continuation:{taskId,tokens:[ready]},executionState:'RUNNING' as const,manualSelection:{status:'SELECTED' as const,requestId}};continuation.update(selected,false);continuation.update(selected,false);
 assert.equal(messages.length,1);assert.match(messages[0]!,/USER_SELECTED, no identidad verificada/);assert.match(messages[0]!,/no escribas ni envíes/);assert.equal(receipts.length,1);
});

test('WAITING_MANUAL resumes once with USER_SELECTED and a frozen draft survives task close without send authority',async()=>{
 const session=randomUUID(),connection=randomUUID(),epoch=randomUUID(),scopeId=randomUUID(),tabId=randomUUID(),documentId=randomUUID(),admissionId=randomUUID(),requestId=randomUUID(),selectionId=randomUUID(),ref=randomUUID();
 const tab={id:tabId,scopeId,title:'WhatsApp Web',url:'https://web.whatsapp.com/',active:true,expiresAt:Date.now()+120_000,state:'ACTIVE' as const};let listener:((connection:string,event:any)=>void)|undefined,selected=false,actions=0;const operations:string[]=[];
 let evidenceRequestId=requestId;
 const observation=()=>({tabId,scopeId,documentId,snapshotId:randomUUID(),expiresAt:Date.now()+15_000,url:tab.url,title:tab.title,elements:[{ref,role:'textbox',name:'',type:'text',disabled:false,action:'blocked' as const}],truncated:false,conversationEvidence:{provenance:{adapter:'whatsapp' as const,version:1 as const},state:'INSUFFICIENT_EVIDENCE' as const,reason:'STRUCTURE_ONLY' as const,conversationKind:'NOT_VERIFIED' as const,truncated:false,activePanelCandidate:true,header:true,composer:true,composerEnabled:true,contactCandidates:0,contactPanel:'NOT_VERIFIED' as const,phoneEvidence:'NOT_VERIFIED' as const,contactAssociation:'NOT_VERIFIED' as const,identity:'NOT_VERIFIED' as const,phoneMatch:'NOT_VERIFIED' as const,handles:{conversation:randomUUID(),header:randomUUID(),composer:randomUUID()},binding:{tabId,scopeId,documentId,epoch},trust:'UNTRUSTED_PAGE_EVIDENCE' as const},...(selected?{manualSelection:{selectionId,manualRequestId:evidenceRequestId,admissionId,taskId:provider.state(session).taskId!,scopeId,tabId,documentId,epoch,expiresAt:Date.now()+60_000,assurance:'USER_SELECTED' as const}}:{})});
 const transport:BrowserTransport={epoch,connections:()=>[connection],subscribe:next=>{listener=next;return()=>{listener=undefined;}},close:()=>{},request:async(_connection,request):Promise<Reply>=>{operations.push(request.operation);if(request.operation==='listAuthorizedTabs')return {outcome:'OK',data:[tab]};if(request.operation==='observe')return {outcome:'OK',data:observation()};if(request.operation==='requestManualSelection')return {outcome:'REQUIRES_USER_INTERACTION',handoffId:requestId,reason:'CONVERSATION_SELECTION'};if(request.operation==='endTask')return {outcome:'OK',data:{completed:true}};actions++;return {outcome:'ERROR',code:'REJECTED'};}};
 const provider=new AttachedChromeProvider(transport),adapter=new BrowserAdapter(provider);try{await adapter.inSession(session,async()=>{
  await adapter.admitGoal(admissionId,'Prepará un borrador para la conversación que voy a seleccionar');await provider.listTabs(new AbortController().signal);
  assert.equal(adapter.tools().some(tool=>tool.id==='browser.requestManualSelection'),true);const pending=await provider.requestManualSelection(new AbortController().signal);assert.equal(pending.outcome,'REQUIRES_USER_INTERACTION');assert.equal(provider.state(session).manualSelection?.status,'PENDING');assert.equal(adapter.state(session)!.executionState,'WAITING_MANUAL');
  const navigate=adapter.tools().find(tool=>tool.id==='browser.navigate')!;const blocked:any=await navigate.execute({url:'https://web.whatsapp.com/'},new AbortController().signal);assert.equal(blocked.browserState.reason,'CONVERSATION_SELECTION');assert.equal(adapter.state(session)!.executionState,'WAITING_MANUAL');assert.equal(actions,0);
  const premature:any=await provider.endTask(new AbortController().signal,{reason:'COMPLETED'});assert.equal(premature.outcome,'END_TASK_REJECTED');
  const taskId=provider.state(session).taskId!;selected=true;const event={protocol:'atlas.browser',version:1,kind:'event',connectionEpoch:epoch,backendSessionId:session,event:'manualSelectionResolved',scopeId,manualRequestId:requestId,manualStatus:'SELECTED',taskId,admissionId};listener?.(connection,{...event,admissionId:randomUUID()});assert.equal(provider.state(session).manualSelection?.status,'PENDING');assert.equal(provider.state(session).ready,null);listener?.(connection,event);
  const ready=provider.state(session).ready;assert.ok(ready);assert.equal(provider.state(session).manualSelection?.status,'SELECTED');listener?.(connection,event);assert.equal(provider.state(session).ready,ready,'duplicate resolution cannot create another continuation');
  provider.acknowledge(provider.state(session).continuation!);
  evidenceRequestId=randomUUID();await assert.rejects(provider.prepareDraft({recipientHint:'Conversación seleccionada',text:'Texto privado'},new AbortController().signal),error=>error instanceof Error);evidenceRequestId=requestId;
  const draft:any=await provider.prepareDraft({recipientHint:'Conversación seleccionada',text:'Texto privado'},new AbortController().signal);assert.equal(draft.status,'FROZEN');assert.equal(draft.selectionAssurance,'USER_SELECTED');assert.equal(draft.intent.recipient.uniqueness,'USER_SELECTED');assert.equal(draft.confirmationEnabled,false);assert.equal(draft.executionEnabled,false);
  const closed:any=await provider.endTask(new AbortController().signal,{reason:'COMPLETED'});assert.equal(closed.outcome,'END_TASK_ACCEPTED');
  const reviewed:any=await provider.reviewDraft(draft.intent.intentId,new AbortController().signal);assert.equal(reviewed.status,'FROZEN');assert.equal(reviewed.contextStatus,'NOT_REVALIDATED');assert.equal(reviewed.confirmationEnabled,false);assert.equal(reviewed.executionEnabled,false);
  assert.equal(adapter.tools().some(tool=>tool.id==='browser.sendMessage'),false);assert.equal(operations.includes('sendSelectedMessage'),false);
 });}finally{await provider.close();}
});

test('reconnection epoch invalidates pending and selected state without blocking a fresh request',async()=>{
 const session=randomUUID(),connection=randomUUID(),scopeId=randomUUID(),tabId=randomUUID(),documentId=randomUUID(),admissionId=randomUUID(),requestId=randomUUID();let epoch=randomUUID(),listener:((connection:string,event:any)=>void)|undefined;
 const tab={id:tabId,scopeId,title:'WhatsApp Web',url:'https://web.whatsapp.com/',active:true,expiresAt:Date.now()+120_000,state:'ACTIVE' as const};
 const transport:BrowserTransport={get epoch(){return epoch;},connections:()=>[connection],subscribe:next=>{listener=next;return()=>{listener=undefined;}},close:()=>{},request:async(_connection,request):Promise<Reply>=>{if(request.operation==='listAuthorizedTabs')return {outcome:'OK',data:[tab]};if(request.operation==='observe')return {outcome:'OK',data:{tabId,scopeId,documentId,snapshotId:randomUUID(),expiresAt:Date.now()+15_000,url:tab.url,title:tab.title,elements:[],truncated:false,conversationEvidence:{provenance:{adapter:'whatsapp',version:1},state:'INSUFFICIENT_EVIDENCE',reason:'STRUCTURE_ONLY',conversationKind:'NOT_VERIFIED',truncated:false,activePanelCandidate:true,header:true,composer:true,composerEnabled:true,contactCandidates:0,contactPanel:'NOT_VERIFIED',phoneEvidence:'NOT_VERIFIED',contactAssociation:'NOT_VERIFIED',identity:'NOT_VERIFIED',phoneMatch:'NOT_VERIFIED',handles:{conversation:randomUUID(),header:randomUUID(),composer:randomUUID()},binding:{tabId,scopeId,documentId,epoch},trust:'UNTRUSTED_PAGE_EVIDENCE'}}};if(request.operation==='requestManualSelection')return {outcome:'REQUIRES_USER_INTERACTION',handoffId:requestId,reason:'CONVERSATION_SELECTION'};return {outcome:'ERROR',code:'REJECTED'};}};
 const provider=new AttachedChromeProvider(transport);try{await provider.inSession(session,async()=>{await provider.admitGoal(admissionId,'Prepará un borrador');await provider.listTabs(new AbortController().signal);await provider.requestManualSelection(new AbortController().signal);assert.equal(provider.state(session).manualSelection?.status,'PENDING');listener?.(connection,{protocol:'atlas.browser',version:1,kind:'event',connectionEpoch:epoch,backendSessionId:session,event:'manualSelectionResolved',scopeId,manualRequestId:requestId,manualStatus:'SELECTED',taskId:provider.state(session).taskId,admissionId});assert.equal(provider.state(session).manualSelection?.status,'SELECTED');epoch=randomUUID();const state=provider.state(session);assert.equal(state.manualSelection?.status,'INVALIDATED');assert.equal(state.workflow,null);await provider.requestManualSelection(new AbortController().signal);assert.equal(provider.state(session).manualSelection?.status,'PENDING');});}finally{await provider.close();}
});

test('residual evidence from non-selected terminal requests cannot prepare a draft',async()=>{
 for(const status of ['CANCELLED','EXPIRED','INVALIDATED'] as const){
  const session=randomUUID(),connection=randomUUID(),epoch=randomUUID(),scopeId=randomUUID(),tabId=randomUUID(),documentId=randomUUID(),admissionId=randomUUID(),requestId=randomUUID(),selectionId=randomUUID();let listener:((connection:string,event:any)=>void)|undefined;
  const tab={id:tabId,scopeId,title:'WhatsApp Web',url:'https://web.whatsapp.com/',active:true,expiresAt:Date.now()+120_000,state:'ACTIVE' as const};
  const transport:BrowserTransport={epoch,connections:()=>[connection],subscribe:next=>{listener=next;return()=>{listener=undefined;}},close:()=>{},request:async(_connection,request):Promise<Reply>=>{if(request.operation==='listAuthorizedTabs')return {outcome:'OK',data:[tab]};if(request.operation==='requestManualSelection')return {outcome:'REQUIRES_USER_INTERACTION',handoffId:requestId,reason:'CONVERSATION_SELECTION'};if(request.operation==='observe')return {outcome:'OK',data:{tabId,scopeId,documentId,snapshotId:randomUUID(),expiresAt:Date.now()+15_000,url:tab.url,title:tab.title,elements:[],truncated:false,conversationEvidence:{provenance:{adapter:'whatsapp',version:1},state:'INSUFFICIENT_EVIDENCE',reason:'STRUCTURE_ONLY',conversationKind:'NOT_VERIFIED',truncated:false,activePanelCandidate:true,header:true,composer:true,composerEnabled:true,contactCandidates:0,contactPanel:'NOT_VERIFIED',phoneEvidence:'NOT_VERIFIED',contactAssociation:'NOT_VERIFIED',identity:'NOT_VERIFIED',phoneMatch:'NOT_VERIFIED',handles:{conversation:randomUUID(),header:randomUUID(),composer:randomUUID()},binding:{tabId,scopeId,documentId,epoch},trust:'UNTRUSTED_PAGE_EVIDENCE'},manualSelection:{selectionId,manualRequestId:requestId,admissionId,taskId:request.taskId,scopeId,tabId,documentId,epoch,expiresAt:Date.now()+60_000,assurance:'USER_SELECTED'}}};return {outcome:'ERROR',code:'REJECTED'};}};
  const provider=new AttachedChromeProvider(transport);try{await provider.inSession(session,async()=>{await provider.admitGoal(admissionId,'Prepará un borrador');await provider.listTabs(new AbortController().signal);await provider.requestManualSelection(new AbortController().signal);listener?.(connection,{protocol:'atlas.browser',version:1,kind:'event',connectionEpoch:epoch,backendSessionId:session,event:'manualSelectionResolved',scopeId,manualRequestId:requestId,manualStatus:status,taskId:provider.state(session).taskId,admissionId});await assert.rejects(provider.prepareDraft({recipientHint:'Conversación',text:'Texto privado'},new AbortController().signal),error=>error instanceof Error);});}finally{await provider.close();}
 }
});
