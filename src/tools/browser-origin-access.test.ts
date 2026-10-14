import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ExtensionController, type Surface } from '../../extension/src/controller.js';
import { AttachedChromeProvider } from '../browser/attached/provider.js';

const origin='https://web.whatsapp.com';
const candidate=(id:number,windowId:number)=>({id,windowId,url:`${origin}/`,title:`WhatsApp ${id}`});
function request(epoch:string,session:string,task:string){return {protocol:'atlas.browser' as const,version:1 as const,kind:'request' as const,requestId:randomUUID(),backendSessionId:session,taskId:task,connectionEpoch:epoch,deadlineAt:Date.now()+10_000,operation:'requestOriginAccess' as const,args:{origin,purpose:'Draft',lifetime:'task' as const}};}
function fixture(candidates:ReturnType<typeof candidate>[],allowed=true){
 const epoch=randomUUID(),session=randomUUID(),task=randomUUID(),events:unknown[]=[];
 const tabs=new Map(candidates.map(tab=>[tab.id,tab]));
 const surface:Surface={current:async()=>{throw new Error('ACTIVE_TAB_AMBIGUOUS');},eligible:async requested=>requested===origin?candidates:[],tab:async id=>{const tab=tabs.get(id);if(!tab)throw new Error('ACTIVE_TAB_UNAVAILABLE');return tab;},create:async()=>{throw new Error('UNSUPPORTED');},activate:async()=>{},navigate:async()=>{},history:async()=>{},content:async()=>({outcome:'ERROR',code:'CONTENT_UNAVAILABLE'}),invalidate:async()=>{}};
 const controller=new ExtensionController(surface,event=>events.push(event),Date.now,randomUUID,{allows:async requested=>allowed&&requested===origin,allowAlways:async()=>{}});
 return {epoch,session,task,events,controller,start:()=>controller.reset({protocol:'atlas.browser',version:1,kind:'hello',connectionEpoch:epoch})};
}

test('one exact authorized origin candidate is granted without active-tab resolution',async()=>{
 const f=fixture([candidate(7,11)]);await f.start();const reply=await f.controller.receive(request(f.epoch,f.session,f.task));
 assert.equal(reply.outcome,'OK');assert.equal(f.controller.authorized().length,1);assert.equal(f.controller.authorized()[0]!.url,origin+'/');assert.equal(f.controller.pending().length,0);
 const repeated=await f.controller.receive(request(f.epoch,f.session,f.task));assert.equal(repeated.outcome,'OK');assert.equal(f.controller.authorized().length,1);
});

test('multiple origin candidates require one trusted popup choice and never select by order',async()=>{
 const f=fixture([candidate(7,11),candidate(8,12)]);await f.start();const reply=await f.controller.receive(request(f.epoch,f.session,f.task));
 assert.equal(reply.outcome,'ACCESS_PENDING');if(reply.outcome!=='ACCESS_PENDING')return;assert.equal(reply.selectionRequired,true);
 const pending=f.controller.pending()[0]!;assert.equal(pending.candidates?.length,2);assert.equal(f.controller.authorized().length,0);
 await assert.rejects(f.controller.selectAccessTab(pending.id,randomUUID()));
 await f.controller.selectAccessTab(pending.id,pending.candidates![1]!.id);
 assert.equal(f.controller.authorized()[0]!.url,origin+'/');assert.equal((f.controller.grants.values().next().value as {chromeId:number}).chromeId,8);assert.equal(f.controller.pending().length,0);
});

test('missing persistent origin policy never auto-grants an eligible tab',async()=>{
 const f=fixture([candidate(7,11)],false);await f.start();const reply=await f.controller.receive(request(f.epoch,f.session,f.task));
 assert.equal(reply.outcome,'ACCESS_PENDING');assert.equal(f.controller.authorized().length,0);assert.equal(f.controller.pending()[0]!.candidates,undefined);
});

test('trusted WhatsApp draft admission freezes origin and uses origin access operation',async()=>{
 const epoch=randomUUID(),connection=randomUUID(),operations:string[]=[];
 const provider=new AttachedChromeProvider({epoch,connections:()=>[connection],subscribe:()=>()=>{},close:()=>{},request:async(_connection,raw)=>{operations.push(raw.operation);return raw.operation==='requestOriginAccess'?{outcome:'ACCESS_PENDING',accessRequestId:randomUUID(),expiresAt:Date.now()+60_000,origin}:{outcome:'ERROR',code:'REJECTED'};}});
 try{await provider.inSession(randomUUID(),async()=>{await provider.admitGoal(randomUUID(),'Seleccioná la conversación de WhatsApp y escribí el mensaje exacto: Prueba. No lo envíes.');const reply=await provider.requestTabAccess({target:{kind:'current'},purpose:'model supplied',lifetime:'task'},new AbortController().signal);assert.equal(reply.outcome,'ACCESS_PENDING');});}finally{await provider.close();}
 assert.equal(operations[0],'requestOriginAccess');assert.equal(operations.filter(operation=>operation==='requestOriginAccess').length,1);
});
