import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID as id } from 'node:crypto';
import { ExtensionController, type Surface } from '../../extension/src/controller.js';
import { parseRequest, type Request, type Reply } from '../browser/attached/protocol.js';

async function fixture() {
  let now=Date.now(),loading=false,waits=0,actions=0,reads=0,creates=0;
  const epoch=id(),session=id(),task=id(),url='https://fixture.example/';
  let allowed=true;
  let onWait=async()=>{if(waits===3)loading=false;};
  const req=(operation:Request['operation'],args:Record<string,unknown>={})=>parseRequest({protocol:'atlas.browser',version:1,kind:'request',requestId:id(),backendSessionId:session,taskId:task,connectionEpoch:epoch,deadlineAt:now+8000,operation,args,observeTrace:operation==='observe'});
  const surface:Surface={current:async()=>({id:7,url,title:''}),tab:async()=>({id:7,url,status:loading?'loading':'complete'}),create:async()=>{++creates;loading=true;return 7;},activate:async()=>{},navigate:async()=>{loading=true;},history:async()=>{},invalidate:async()=>{},content:async(_,grant,request):Promise<Reply>=>{
    if(request.operation==='click'){++actions;loading=true;return {outcome:'OK',data:{completed:true}};}
    ++reads;return {outcome:'OK',data:{tabId:grant.tabId,scopeId:grant.scopeId,documentId:id(),snapshotId:id(),expiresAt:now+15000,url,title:'',elements:[{ref:id(),role:'link',type:'',name:'Result',disabled:false,action:'navigation',capabilities:['OPEN_LINK']}],truncated:false}};
  }};
  const controller=new ExtensionController(surface,()=>{},()=>now,id,{allows:async()=>allowed,allowAlways:async()=>{}},undefined,async ms=>{now+=ms;++waits;await onWait();});
  await controller.reset({protocol:'atlas.browser',version:1,kind:'hello',connectionEpoch:epoch});
  await controller.receive(req('requestTabAccess',{target:{kind:'new',url},purpose:'Fixture',lifetime:'task'}));
  const grant=controller.authorized()[0]!;
  const observe=()=>controller.receive(req('observe',{tabId:grant.id,scopeId:grant.scopeId}));
  return {controller,req,observe,grant,stats:()=>({waits,actions,reads,creates}),setWait:(fn:()=>Promise<void>)=>{onWait=fn;},setReady:()=>{loading=false;},setLoading:()=>{loading=true;},setAllowed:(value:boolean)=>{allowed=value;}};
}
test('open → loading document → observe waits inside one READ and returns a fresh snapshot',async()=>{
 const f=await fixture();const reply=await f.observe();assert.equal(reply.outcome,'OK');assert.deepEqual(f.stats(),{waits:3,actions:0,reads:1,creates:1});assert.ok(reply.observeTrace?.some(row=>row.failureReason==='DOCUMENT_INITIALIZING'));
});
test('click navigation → loading document → observe never repeats click and produces new refs',async()=>{
 const f=await fixture();const before:any=await f.observe();const s=before.data;
 assert.equal((await f.controller.receive(f.req('click',{scopeId:s.scopeId,tabId:s.tabId,documentId:s.documentId,snapshotId:s.snapshotId,ref:s.elements[0].ref}))).outcome,'OK');
 let ticks=0;f.setWait(async()=>{if(++ticks===2) { // Replace only the readiness fixture, not an action.
   f.setReady();
 }});
 const after:any=await f.observe();assert.equal(after.outcome,'OK');assert.notEqual(after.data.snapshotId,s.snapshotId);assert.notEqual(after.data.elements[0].ref,s.elements[0].ref);assert.equal(f.stats().actions,1);assert.equal(f.stats().reads,2);
});
test('document never ready: bounded wait, no dispatch and explicit initialization diagnostic',async()=>{
 const f=await fixture();f.setWait(async()=>{});const reply=await f.observe();assert.deepEqual({outcome:reply.outcome,code:(reply as any).code},{outcome:'ERROR',code:'CONTENT_UNAVAILABLE'});assert.equal(f.stats().waits,20);assert.equal(f.stats().reads,0);
});
for(const stop of ['revoke','epoch','expiry','cancel'] as const)test(`readiness wait stops safely on ${stop}`,async()=>{
 const f=await fixture();const request=f.req('observe',{scopeId:f.grant.scopeId,tabId:f.grant.id});f.setWait(async()=>{
 if(stop==='revoke')await f.controller.revoke(f.grant.scopeId);
 if(stop==='epoch')await f.controller.reset();
 if(stop==='expiry')f.controller.grants.get(f.grant.scopeId)!.expiresAt=0;
 if(stop==='cancel')f.controller.cancel({protocol:'atlas.browser',version:1,kind:'cancel',connectionEpoch:request.connectionEpoch,backendSessionId:request.backendSessionId,requestId:request.requestId});
 });
 const reply=await f.controller.receive(request);assert.equal(reply.outcome,'ERROR');assert.equal(f.stats().reads,0);assert.equal(f.stats().actions,0);
});
test('interaction during loading is not retried or delayed as a READ',async()=>{
 const f=await fixture();const before:any=await f.observe();f.setLoading();const s=before.data;const n=f.stats().waits;
 const reply=await f.controller.receive(f.req('click',{scopeId:s.scopeId,tabId:s.tabId,documentId:s.documentId,snapshotId:s.snapshotId,ref:s.elements[0].ref}));assert.equal(reply.outcome,'ERROR');assert.equal(f.stats().actions,0);assert.equal(f.stats().waits,n);
});
test('permission removal during readiness wait fails closed before content dispatch',async()=>{
 const f=await fixture();f.setWait(async()=>{f.setReady();f.setAllowed(false);});
 const reply=await f.observe();assert.equal(reply.outcome,'ERROR');assert.equal(f.stats().reads,0);assert.equal(f.controller.authorized().length,0);
});
