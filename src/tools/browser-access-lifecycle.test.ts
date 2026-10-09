import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID as id } from 'node:crypto';
import { ExtensionController, type Surface } from '../../extension/src/controller.js';
import { AttachedChromeProvider } from '../browser/attached/provider.js';
import { BrowserAdapter } from './adapters/browser.js';
import { ToolError } from './types.js';
import { JARVIS_BROWSER_INSTRUCTIONS } from '../core/personality.js';
function fixture(allowed=true){
 const epoch=id(),connection=id(),session=id();let reads=0,opens=0;const calls:string[]=[];const listeners=new Set<(connection:string,event:any)=>void>();
 const surface:Surface={current:async()=>({id:7,url:'https://fixture.example/',title:'Fixture'}),create:async()=>{++opens;return 8;},activate:async()=>{},navigate:async()=>{},history:async()=>{},invalidate:async()=>{},content:async(_,grant)=>{++reads;return {outcome:'OK',data:{tabId:grant.tabId,scopeId:grant.scopeId,documentId:id(),snapshotId:id(),expiresAt:Date.now()+15000,url:grant.origin+'/',title:'Fixture',elements:[],truncated:false}};}};
 const controller=new ExtensionController(surface,event=>{for(const listener of listeners)listener(connection,event);},Date.now,id,{allows:async()=>allowed,allowAlways:async()=>{}});
 const provider=new AttachedChromeProvider({epoch,connections:()=>[connection],subscribe:l=>{listeners.add(l);return()=>listeners.delete(l);},request:async(_,req)=>{calls.push(req.operation);return controller.receive(req);},close:()=>{}});
 const adapter=new BrowserAdapter(provider);
 const run=<T>(work:()=>Promise<T>)=>adapter.inSession(session,work);
 const invoke=async(name:string,input:unknown={})=>adapter.tools().find(tool=>tool.id==='browser.'+name)!.execute(input,new AbortController().signal) as Promise<any>;
 return {session,controller,provider,adapter,run,invoke,calls,stats:()=>({reads,opens}),start:()=>controller.reset({protocol:'atlas.browser',version:1,kind:'hello',connectionEpoch:epoch})};
}
test('ALLOW without operational binding: first observe returns access REQUIRED, never observes/opens/authorizes',async()=>{
 const h=fixture();await h.start();await h.run(async()=>{
  assert.equal((await h.invoke('accessStatus')).status,'REQUIRED');
  const result=await h.invoke('observe');assert.equal(result.browserAccess.status,'REQUIRED');assert.equal(result.observed,false);assert.equal(result.browserAccess.nextTool,'browser.requestAccess');
  assert.equal(h.controller.authorized().length,0);assert.deepEqual(h.calls,[]);assert.deepEqual(h.stats(),{reads:0,opens:0});
  await assert.rejects(h.provider.observe(new AbortController().signal),e=>e instanceof ToolError&&e.browserObservation?.status==='FAILED'&&e.browserObservation.reason==='OPERATIONAL_ACCESS_REQUIRED');
 });await h.provider.close();
});
test('requestAccess → observe → accepted close → fresh task/access → observe never reuses old binding/snapshot',async()=>{
 const h=fixture();await h.start();await h.run(async()=>{
  await h.provider.admitGoal(id(),'¿Qué dice esta página?');
  await h.invoke('requestAccess',{target:{kind:'current'},purpose:'Read',lifetime:'task'});
  const oldTask=h.provider.state(h.session).taskId;
  const oldGrant=h.controller.authorized()[0]!;
  const first=await h.invoke('observe');assert.ok(first.snapshotId);
  const task=(await h.provider.endTask(new AbortController().signal,{reason:'COMPLETED'})) as any;assert.equal(task.outcome,'END_TASK_ACCEPTED');
  assert.equal(h.controller.authorized().length,0);assert.notEqual(h.provider.state(h.session).taskId,oldTask);assert.equal((await h.invoke('accessStatus')).status,'REQUIRED');
  assert.equal((await h.invoke('observe')).observed,false);
  await h.provider.admitGoal(id(),'¿Qué dice esta página?');
  await h.invoke('requestAccess',{target:{kind:'current'},purpose:'Read again',lifetime:'task'});
  const fresh=h.controller.authorized()[0]!;assert.notEqual(fresh.scopeId,oldGrant.scopeId);
  const second=await h.invoke('observe');assert.notEqual(second.snapshotId,first.snapshotId);assert.notEqual(second.scopeId,first.scopeId);
  assert.deepEqual(h.calls,['requestTabAccess','observe','endTask','requestTabAccess','observe']);assert.equal(h.stats().opens,0);
 });await h.provider.close();
});
test('rejected endTask preserves grant and task for action-required objective',async()=>{
 const h=fixture();await h.start();await h.run(async()=>{
  await h.provider.admitGoal(id(),'Buscá una canción');await h.invoke('requestAccess',{target:{kind:'current'},purpose:'Read',lifetime:'task'});await h.invoke('observe');
  const grant=h.controller.authorized()[0]!;assert.equal((await h.invoke('endTask',{reason:'COMPLETED'})).outcome,'END_TASK_REJECTED');
  assert.equal((await h.invoke('accessStatus')).status,'READY');assert.equal(h.controller.authorized()[0]!.scopeId,grant.scopeId);assert.equal(h.calls.includes('endTask'),false);
 });await h.provider.close();
});
test('pending access never dispatches observe or duplicates requests; explicit deny blocks retries until trusted new admission',async()=>{
 const h=fixture(false);await h.start();await h.run(async()=>{
  await h.provider.admitGoal(id(),'¿Qué dice esta página?');await h.invoke('requestAccess',{target:{kind:'current'},purpose:'Read',lifetime:'task'});
  assert.equal((await h.invoke('observe')).browserAccess.status,'PENDING');
  await h.invoke('requestAccess',{target:{kind:'current'},purpose:'Read',lifetime:'task'});assert.deepEqual(h.calls,['requestTabAccess']);
  h.controller.deny(h.controller.pending()[0]!.id,true);
  assert.equal((await h.invoke('observe')).browserAccess.status,'USER_REJECTED');
  assert.equal((await h.invoke('requestAccess',{target:{kind:'current'},purpose:'Read',lifetime:'task'})).browserAccess.status,'USER_REJECTED');
  await assert.rejects(h.provider.requestTabAccess({target:{kind:'current'},purpose:'Read',lifetime:'task'},new AbortController().signal));assert.deepEqual(h.calls,['requestTabAccess']);
  await h.provider.admitGoal(id(),'¿Qué dice esta página?');await h.invoke('requestAccess',{target:{kind:'current'},purpose:'Read',lifetime:'task'});assert.equal(h.calls.length,2);
 });await h.provider.close();
});
test('tool contracts require explicit access, distinguish closed task, and never tell agent to substitute open',async()=>{
 const h=fixture();const tools=h.adapter.tools();assert.equal(tools.find(t=>t.id==='browser.accessStatus')!.permission,'READ');
 assert.match(tools.find(t=>t.id==='browser.observe')!.description,/requestAccess explícito/);
 for(const text of ['browser.accessStatus','Nunca uses browser.open como sustituto','USER_REJECTED','END_TASK_ACCEPTED'])assert.ok(JARVIS_BROWSER_INSTRUCTIONS.includes(text));
 assert.equal(h.provider.operationalAccess().status,'INVALIDATED');await h.provider.close();
});
test('technical revocation is not explicit rejection and expired grants never enable observation',async()=>{
 const h=fixture();await h.start();await h.run(async()=>{
  await h.invoke('requestAccess',{target:{kind:'current'},purpose:'Read',lifetime:'task'});
  const original=Date.now;try{Date.now=()=>original()+16*60_000;assert.equal((await h.invoke('accessStatus')).status,'EXPIRED');assert.equal((await h.invoke('observe')).observed,false);}finally{Date.now=original;}
  await h.controller.revoke(h.controller.authorized()[0]!.scopeId);
  assert.equal((await h.invoke('observe')).browserAccess.status,'REVOKED');
  await h.invoke('requestAccess',{target:{kind:'current'},purpose:'New explicit request',lifetime:'task'});assert.equal((await h.invoke('accessStatus')).status,'READY');
 });await h.provider.close();
});
test('accessStatus outside a session and direct observe outside a session are distinctly invalidated',async()=>{
 const h=fixture();assert.equal(h.provider.operationalAccess().status,'INVALIDATED');
 await assert.rejects(h.provider.observe(new AbortController().signal),e=>e instanceof ToolError&&e.browserObservation?.status==='FAILED'&&e.browserObservation.reason==='TASK_SESSION_INVALIDATED');await h.provider.close();
});
