import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { JSDOM } from 'jsdom';
import { ContentEngine } from '../../extension/src/content-engine.js';
import { ExtensionController } from '../../extension/src/controller.js';
import type { Surface } from '../../extension/src/controller.js';
import { ConsequentialFoundation } from '../browser/consequential/foundation.js';
import type { DraftContext } from '../browser/consequential/semantic.js';

const source='<main id="main" data-testid="conversation-panel-wrapper"><header data-testid="conversation-header">PERSONAL_NAME</header><footer><div data-testid="conversation-compose-box-input" role="textbox" contenteditable="true"></div><button>Send</button></footer></main>';
function fixture(html=source){
 const dom=new JSDOM(html,{url:'https://web.whatsapp.com/',pretendToBeVisual:true}),win=dom.window;
 win.HTMLElement.prototype.checkVisibility=function(){return !this.closest('[hidden],[aria-hidden="true"]');};
 win.HTMLElement.prototype.getBoundingClientRect=function(){const x=[...win.document.querySelectorAll('*')].indexOf(this)*8;return {left:x,right:x+6,top:0,bottom:6,width:6,height:6,x,y:0,toJSON(){}};};
 win.document.elementFromPoint=x=>[...win.document.querySelectorAll('*')].find(n=>{const r=n.getBoundingClientRect();return x>=r.left&&x<=r.right;})??null;
 const access={scopeId:randomUUID(),tabId:randomUUID(),session:randomUUID(),epoch:randomUUID(),origin:'https://web.whatsapp.com',expiresAt:Date.now()+60_000};
 const engine=new ContentEngine(win as unknown as Window & typeof globalThis,Date.now,randomUUID,async()=>{});engine.initialize(access);
 return {win,engine,access,close:()=>{engine.destroy();win.close();}};
}

test('a popup selection binds only the current conversation and does not assert verified identity',async()=>{
 const f=fixture();try{
  assert.equal(f.engine.selectConversation(f.access),true);
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
 const f=fixture();try{assert.equal(f.engine.selectConversation(f.access),true);f.engine.documentChanged();const result=await f.engine.run('observe',{scopeId:f.access.scopeId,tabId:f.access.tabId},Date.now()+5000,{session:f.access.session,epoch:f.access.epoch});assert.equal(result.outcome,'OK');if(result.outcome==='OK'&&'manualSelection'in result.data)assert.equal(result.data.manualSelection,undefined);}finally{f.close();}
 const group=fixture(source.replace('<header data-testid="conversation-header"','<header aria-label="Group info" data-testid="conversation-header"'));
 try{assert.equal(group.engine.selectConversation(group.access),false);}finally{group.close();}
});

test('user selection yields a private draft with distinct assurance and material change invalidates it',()=>{
 const now=Date.now(),id=randomUUID(),selection={selectionId:id,scopeId:randomUUID(),tabId:randomUUID(),documentId:randomUUID(),epoch:randomUUID(),expiresAt:now+50_000,assurance:'USER_SELECTED' as const};
 const context:DraftContext={backendSessionId:randomUUID(),taskId:randomUUID(),admissionId:randomUUID(),connectionEpoch:selection.epoch,origin:'https://web.whatsapp.com',scopeId:selection.scopeId,tabId:selection.tabId,documentId:selection.documentId,snapshotId:randomUUID(),snapshotExpiresAt:now+15_000,grantExpiresAt:now+60_000,chromePermission:true,siteAuthorized:true,grantValid:true,requestedIdentifiers:[],semantic:{origin:'https://web.whatsapp.com',conversations:[],truncated:false,trust:'UNTRUSTED_PAGE_EVIDENCE'},manualSelection:selection};
 const foundation=ConsequentialFoundation.drafts(context.backendSessionId),signal=new AbortController().signal;
 const result=foundation.prepareDraft({recipientHint:'Sofía',text:'Llego a las ocho'},context,signal);
 assert.equal(result.status,'FROZEN');if(!('intent'in result))throw new Error();
 assert.equal(result.intent.recipient.uniqueness,'USER_SELECTED');assert.equal(result.confirmationEnabled,false);assert.equal(result.executionEnabled,false);
 assert.ok(result.intent.expiresAt>context.snapshotExpiresAt,'voice confirmation survives the preparing snapshot TTL');
 assert.equal(foundation.reviewDraft(result.intent.intentId,{...context,snapshotId:randomUUID()}).status,'FROZEN');
 assert.equal(foundation.reviewDraft(result.intent.intentId,{...context,manualSelection:{...selection,selectionId:randomUUID()}}).status,'INVALIDATED');
 assert.throws(()=>foundation.execute(result.intent.intentId,signal));
});

test('direct content command never writes or clicks Send for absent, false, invalid or true configuration',async()=>{
 const f=fixture(source.replace('<button>Send</button>','<button aria-label="Send">Send</button>'));
 try{
  const composer=f.win.document.querySelector('[data-testid="conversation-compose-box-input"]')!;
  let clicks=0,writes=0;f.win.document.querySelector('button')!.addEventListener('click',()=>{clicks++;});
  Object.defineProperty(f.win.document,'execCommand',{value:()=>{writes++;return true;}});
  assert.equal(f.engine.selectConversation(f.access),true);
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
   assert.equal(f.engine.selectConversation(f.access),true);
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
 const epoch=randomUUID(),session=randomUUID(),task=randomUUID();let url='https://web.whatsapp.com/',now=Date.now(),selections=0;
 const surface:Surface={current:async()=>({id:7,url,title:'Test'}),create:async()=>7,activate:async()=>{},navigate:async()=>{},history:async()=>{},invalidate:async()=>{},content:async()=>({outcome:'ERROR',code:'REJECTED'}),selectConversation:async()=>{selections++;return true;}};
 const controller=new ExtensionController(surface,()=>{},()=>now,randomUUID,{allows:async origin=>origin==='https://web.whatsapp.com',allowAlways:async()=>{}});
 await controller.reset({protocol:'atlas.browser',version:1,kind:'hello',connectionEpoch:epoch});
 const request={protocol:'atlas.browser',version:1,kind:'request',requestId:randomUUID(),backendSessionId:session,taskId:task,connectionEpoch:epoch,deadlineAt:now+10_000,operation:'requestTabAccess',args:{target:{kind:'current'},purpose:'Test',lifetime:'task'}};
 const reply=await controller.receive(request);assert.equal(reply.outcome,'OK');if(reply.outcome!=='OK'||!('scopeId'in reply.data))throw new Error();const scopeId=reply.data.scopeId;
 assert.equal(await controller.selectConversation(scopeId),true);assert.equal(selections,1);
 const direct=await controller.receive({...request,requestId:randomUUID(),operation:'sendSelectedMessage',args:{scopeId,tabId:(reply.data as {id:string}).id,documentId:randomUUID(),selectionId:randomUUID(),text:'Test'}});
 assert.equal(direct.outcome,'ERROR');if(direct.outcome==='ERROR')assert.equal(direct.code,'REJECTED');
 url='https://example.test/';await assert.rejects(controller.selectConversation(scopeId));assert.equal(selections,1);
 url='https://web.whatsapp.com/';await controller.revoke(scopeId);await assert.rejects(controller.selectConversation(scopeId));assert.equal(selections,1);
});
