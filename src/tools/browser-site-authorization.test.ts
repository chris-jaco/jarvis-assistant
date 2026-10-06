import { PopupDiagnostics } from '../diagnostics/popup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID as id } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { SiteAuthorization, hostPattern } from '../../extension/src/site-authorization.js';
import type { SiteEnvironment } from '../../extension/src/site-authorization.js';
import { chromeSiteEnvironment } from '../../extension/src/site-storage.js';
import { ExtensionController } from '../../extension/src/controller.js';
import type { Surface } from '../../extension/src/controller.js';
import { executionState, executionInstruction } from '../browser/execution-state.js';
import { AttachedChromeProvider } from '../browser/attached/provider.js';
import { BrowserAdapter } from './adapters/browser.js';
import type { BrowserTransport } from '../browser/attached/transport.js';
import { BrowserContinuation } from '../provider/browser-continuation.js';
const A='https://first.example', B='https://second.example', C='https://third.example';
function storage() {
  let file: unknown; const permissions=new Set<string>(); const invalidations:string[]=[];
  const env:SiteEnvironment={load:async()=>structuredClone(file),save:async value=>{file=structuredClone(value);},contains:async p=>permissions.has(p),remove:async p=>permissions.delete(p)};
  return {env,permissions,invalidations,policy:()=>new SiteAuthorization(env,async origin=>{invalidations.push(origin);})};
}
function runtime(diagnostics?:PopupDiagnostics) {
  const store=storage(); let controller:ExtensionController; let reads=0,navigations=0,invalidations=0; const events:any[]=[];const listeners=new Set<(connection:string,event:any)=>void>();const connection=id();
  const tab={id:7,url:A+'/',title:'Fixture',status:'complete'};
  const policy=new SiteAuthorization(store.env,async origin=>controller.revokeOrigin(origin));
  const surface:Surface={current:async()=>tab,tab:async()=>tab,create:async url=>{tab.url=url;return tab.id;},activate:async()=>{},navigate:async(_,url)=>{++navigations;tab.url=url;},history:async()=>{},invalidate:async()=>{++invalidations;},content:async(_tab,grant)=>{++reads;return {outcome:'OK',data:{tabId:grant.tabId,scopeId:grant.scopeId,truncated:false,title:'Fixture',url:grant.origin+'/',documentId:id(),snapshotId:id(),expiresAt:Date.now()+15000,elements:[]}};}};
  controller=new ExtensionController(surface,event=>{events.push(event);for(const listener of listeners)listener(connection,event);},Date.now,id,policy,diagnostics);
  const session=id(),task=id(); let epoch=id();
  const req=(operation:string,args:unknown={},extra:object={})=>({protocol:'atlas.browser',version:1,kind:'request',requestId:id(),backendSessionId:session,taskId:task,connectionEpoch:epoch,deadlineAt:Date.now()+20000,operation,args,...extra});
  const reset=async()=>{epoch=id();await controller.reset({protocol:'atlas.browser',version:1,kind:'hello',connectionEpoch:epoch});};
  const allow=async(origin:string)=>{store.permissions.add(hostPattern(origin));await policy.allowAlways(origin);};
  const access=()=>controller.receive(req('requestTabAccess',{target:{kind:'current'},purpose:'Explicit task',lifetime:'task'}));
  const observe=(grant=controller.authorized()[0]!)=>controller.receive(req('observe',{scopeId:grant.scopeId,tabId:grant.id}));
  const transport:BrowserTransport={get epoch(){return epoch;},connections:()=>[connection],request:async(_,request)=>controller.receive(request),subscribe:listener=>{listeners.add(listener);return()=>listeners.delete(listener);},close:()=>{}};
  return {session,transport,controller,policy,store,tab,events,req,reset,allow,access,observe,stats:()=>({reads,navigations,invalidations})};
}
test('exact-origin policy requires BOTH saved ALLOW and effective Chrome permission; restart reconciles without observing',async()=>{
  const s=storage(),p=s.policy();assert.equal(await p.allows(A),false);
  s.permissions.add(hostPattern(A));assert.equal(await p.allows(A),false);
  await p.allowAlways(A);assert.equal(await p.allows(A),true);
  assert.equal(await p.allows('https://sub.first.example'),false);assert.equal(await p.allows('http://first.example'),false);
  assert.equal(await s.policy().allows(A),true);
  s.permissions.delete(hostPattern(A));await p.reconcile();assert.equal(await p.allows(A),false);assert.deepEqual(await p.list(),[]);assert.deepEqual(s.invalidations,[A]);
  assert.equal(await s.policy().allows(A),false);
});
test('invalid persistence and ungranted origins fail closed; storage is trusted-context only',async()=>{
  const s=storage();await assert.rejects(s.policy().allowAlways(A));assert.throws(()=>hostPattern(A+'/path'));assert.throws(()=>hostPattern('http://first.example'));
  const p=new SiteAuthorization({...s.env,load:async()=>({version:1,sites:[{origin:A,createdAt:0,extra:'untrusted'}]})},async()=>{});assert.equal(await p.allows(A),false);
  const calls:unknown[]=[];const api={storage:{local:{setAccessLevel:async(x:unknown)=>{calls.push(x);},get:async()=>({}),set:async(x:unknown)=>{calls.push(x);}}},permissions:{contains:async()=>false,remove:async()=>false}};
  await chromeSiteEnvironment(api as any).load();assert.deepEqual(calls,[{accessLevel:'TRUSTED_CONTEXTS'}]);
});
test('allow once creates only a temporary operational grant; restart never restores grants or background observations',async()=>{
  const r=runtime();await r.reset();const pending:any=await r.access();assert.equal(pending.outcome,'ACCESS_PENDING');await r.controller.approve(pending.accessRequestId,A,false);
  assert.equal(await r.policy.allows(A),false);assert.equal((await r.observe()).outcome,'OK');const old=r.controller.authorized()[0]!;await r.reset();const before=r.stats().reads;
  assert.equal((await r.observe(old)).outcome,'ERROR');assert.equal(r.stats().reads,before);assert.equal((await r.access()).outcome,'ACCESS_PENDING');
});
test('allow always from trusted approval persists, but restart and absent task cannot observe',async()=>{
  const r=runtime();await r.reset();r.store.permissions.add(hostPattern(A));const pending:any=await r.access();await r.controller.approve(pending.accessRequestId,A,true);assert.equal(await r.policy.allows(A),true);
  const old=r.controller.authorized()[0]!;const before=r.stats().reads;await r.reset();assert.equal((await r.observe(old)).outcome,'ERROR');assert.equal(r.stats().reads,before);
  assert.equal((await r.access()).outcome,'OK');assert.equal(r.stats().reads,before);assert.equal((await r.observe()).outcome,'OK');
  const grant=r.controller.authorized()[0]!;const count=r.stats().reads;assert.equal((await r.controller.receive(r.req('observe',{scopeId:grant.scopeId,tabId:grant.id},{taskId:id()}))).outcome,'ERROR');assert.equal(r.stats().reads,count);
});
test('revoke is immediate and invalidates grants, refs and pending transitions; external permission removal does the same',async()=>{
  const r=runtime();await r.reset();await r.allow(A);await r.access();const old=r.controller.authorized()[0]!;
  await r.controller.receive(r.req('navigate',{scopeId:old.scopeId,tabId:old.id,url:B+'/'}));assert.equal(r.controller.pending().length,1);
  await r.policy.revoke(A);assert.equal(r.controller.pending().length,0);assert.equal(r.controller.authorized().length,0);assert.ok(r.events.some(e=>e.event==='accessRevoked'&&e.accessRequestId));assert.equal((await r.observe(old)).outcome,'ERROR');
  r.tab.url=A+'/';await r.allow(A);await r.access();r.store.permissions.delete(hostPattern(A));await r.policy.reconcile();assert.equal(r.controller.authorized().length,0);assert.ok(r.stats().invalidations>0);
});
test('cross-origin ALLOW rotates scope, preserves tab identity, invalidates old refs and requires fresh READ',async()=>{
  const r=runtime();await r.reset();await r.allow(A);await r.allow(B);await r.access();const old=r.controller.authorized()[0]!;
  const nav=await r.controller.receive(r.req('navigate',{scopeId:old.scopeId,tabId:old.id,url:B+'/'}));assert.equal(nav.outcome,'OK');const fresh=r.controller.authorized()[0]!;
  assert.notEqual(fresh.scopeId,old.scopeId);assert.equal(fresh.id,old.id);assert.equal(r.controller.pending().length,0);assert.equal((await r.observe(old)).outcome,'ERROR');assert.equal((await r.observe(fresh)).outcome,'OK');assert.equal(r.stats().navigations,1);
});
test('cross-origin ASK preserves navigation completion, suspends observation and resumes only after actual popup approval',async()=>{
  const r=runtime();await r.reset();await r.allow(A);await r.access();const old=r.controller.authorized()[0]!;
  assert.equal((await r.controller.receive(r.req('navigate',{scopeId:old.scopeId,tabId:old.id,url:B+'/'}))).outcome,'OK');assert.equal(r.events.at(-1).event,'accessRequired');const before=r.stats().reads;
  const pending:any=await r.observe(old);assert.equal(pending.outcome,'ACCESS_PENDING');assert.equal(r.stats().reads,before);
  await assert.rejects(r.controller.approve(pending.accessRequestId,A));await r.controller.preparePending();await r.controller.approve(pending.accessRequestId,B,false);assert.equal((await r.observe()).outcome,'OK');assert.equal(r.stats().navigations,1);assert.equal(await r.policy.allows(B),false);
});
test('redirect to unallowed third origin does not inherit destination permission; same-origin document change retains grant',async()=>{
  const r=runtime();await r.reset();await r.allow(A);await r.allow(B);await r.access();const first=r.controller.authorized()[0]!;
  await r.controller.documentChanged(r.tab.id);assert.equal(r.controller.authorized()[0]!.scopeId,first.scopeId);
  await r.controller.receive(r.req('navigate',{scopeId:first.scopeId,tabId:first.id,url:B+'/'}));const second=r.controller.authorized()[0]!;r.tab.url=C+'/';await r.controller.documentChanged(r.tab.id);const count=r.stats().reads;
  const pending:any=await r.observe(second);assert.equal(pending.outcome,'ACCESS_PENDING');assert.equal(pending.origin,C);assert.equal(r.stats().reads,count);
});
test('revocation during approval cannot publish a grant or perform an approval READ',async()=>{
  const r=runtime();await r.reset();const pending:any=await r.access();r.controller.deny(pending.accessRequestId);const count=r.stats().reads;await assert.rejects(r.controller.approve(pending.accessRequestId,A));assert.equal(r.stats().reads,count);assert.equal(r.controller.authorized().length,0);
});
test('site consent never approves consequential actions; RUNNING silent and all waiting states request user',async()=>{
  assert.equal(executionState('RUNNING',{outcome:'ACCESS_PENDING'},false,false),'WAITING_ACCESS');assert.equal(executionState('RUNNING',{outcome:'REQUIRES_USER_INTERACTION'},false,false),'WAITING_MANUAL');assert.equal(executionState('RUNNING',null,true,true),'WAITING_CONFIRMATION');
  assert.match(executionInstruction('RUNNING'),/silencio.*sin acknowledgement/);for(const state of ['WAITING_ACCESS','WAITING_MANUAL','WAITING_CONFIRMATION'] as const)assert.match(executionInstruction(state),/solicitar.*usuario/);
  const messages:string[]=[];const continuation=new BrowserContinuation(async()=>({outcome:'OK',data:{}}),text=>messages.push(text));continuation.update({workflow:null,ready:id(),executionState:'RUNNING'},false);assert.match(messages[0]!,/sin.*acknowledgement|silencio/);
  const manifest=JSON.parse(await readFile('extension/manifest.json','utf8'));assert.deepEqual(manifest.optional_host_permissions,['https://*/*']);assert.ok(!manifest.permissions.includes('tabs'));assert.ok(!manifest.permissions.includes('debugger'));
});
test('packaged popup lists/revokes sites and requests granular permission directly from user gesture',async()=>{
  const html=await readFile('extension/popup.html','utf8'),script=await readFile('dist/extension/popup.js','utf8');const dom=new JSDOM(html,{runScripts:'outside-only'});const calls:any[]=[];let removed=()=>{};
  const state={connected:true,pending:[{id:id(),origin:A,tabSelected:true,purpose:'Fixture',lifetime:'task'}],authorized:[],sites:[{origin:B,allowed:true}]};
  (dom.window as any).chrome={runtime:{sendMessage:async(x:any)=>{calls.push(x);return state;}},permissions:{request:(x:any)=>{calls.push({request:x});return Promise.resolve(true);},onRemoved:{addListener:(fn:()=>void)=>{removed=fn;}},onAdded:{addListener:()=>{}}}};
  try {(dom.window as any).hostPattern=hostPattern;(dom.window as any).PopupDiagnostics=PopupDiagnostics;Object.defineProperty(dom.window.crypto,'randomUUID',{value:id});dom.window.eval(script.replace(/^import .*;$/gm,''));await new Promise(resolve=>setTimeout(resolve,0));assert.match(dom.window.document.querySelector('#sites')!.textContent!,/second.example.*ALLOW/);
    const buttons=[...dom.window.document.querySelectorAll('button')];buttons.find(b=>b.textContent==='Permitir siempre este sitio')!.click();assert.equal(JSON.stringify(calls.at(-1)),JSON.stringify({request:{origins:[A+'/*']}}));await new Promise(resolve=>setTimeout(resolve,0));assert.ok(calls.some(c=>c.action==='approve'&&c.always&&c.origin===A));
    [...dom.window.document.querySelectorAll('button')].find(b=>b.textContent==='Revocar')!.click();await new Promise(resolve=>setTimeout(resolve,0));assert.ok(calls.some(c=>c.action==='revokeSite'&&c.origin===B));const n=calls.length;removed();await new Promise(resolve=>setTimeout(resolve,0));assert.ok(calls.length>n);
  }finally{dom.window.close();}
});

test('revocation defeats an in-flight persistent write and remains fail closed across storage failure',async()=>{
  const s=storage();s.permissions.add(hostPattern(A));let release!:()=>void;let entered!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;});const gate=new Promise<void>(resolve=>{release=resolve;});
  const p=new SiteAuthorization({...s.env,save:async value=>{entered();await gate;await s.env.save(value);}},async origin=>{s.invalidations.push(origin);});
  const approval=p.allowAlways(A);await started;const revoked=p.revoke(A);assert.equal(await p.allows(A),false);release();await assert.rejects(approval);await revoked;assert.equal(await p.allows(A),false);assert.equal(await s.policy().allows(A),false);
  const broken=new SiteAuthorization({...s.env,save:async()=>{throw new Error('private diagnostic');}},async()=>{});s.permissions.add(hostPattern(A));await assert.rejects(broken.allowAlways(A),/ACCESS_DENIED/);assert.equal(await broken.allows(A),false);assert.equal(s.permissions.size,0);
});

test('production adapter preserves COMPLETED cross-origin navigation plus failed access observation; approval resumes without retry',async()=>{
  const r=runtime();await r.reset();await r.allow(A);const provider=new AttachedChromeProvider(r.transport);const adapter=new BrowserAdapter(provider);
  await adapter.inSession(r.session,async()=>{
    await provider.openTab(A+'/',new AbortController().signal);await provider.observe(new AbortController().signal);
    const navigate=adapter.tools().find(tool=>tool.id==='browser.navigate')!;const result:any=await navigate.execute({url:B+'/'},new AbortController().signal);
    assert.equal(result.action.status,'COMPLETED');assert.equal(result.observation.status,'FAILED');assert.equal(r.stats().navigations,1);assert.equal(adapter.state(r.session)!.executionState,'WAITING_ACCESS');
    const pending=r.controller.pending()[0]!;await r.controller.preparePending();await r.controller.approve(pending.id,B);assert.equal(adapter.state(r.session)!.executionState,'RUNNING');await provider.observe(new AbortController().signal);assert.equal(r.stats().navigations,1);
    await r.policy.revoke(A); // Does not revoke a separately authorized B grant.
    assert.equal(r.controller.authorized().length,1);await r.controller.revoke(r.controller.authorized()[0]!.scopeId);assert.equal(adapter.state(r.session)!.executionState,'FAILED');
    const access=adapter.tools().find(tool=>tool.id==='browser.requestAccess')!;await access.execute({target:{kind:'current'},purpose:'New request',lifetime:'task'},new AbortController().signal);assert.equal(adapter.state(r.session)!.executionState,'WAITING_ACCESS');
    const ticket=r.controller.pending()[0]!;await r.controller.approve(ticket.id,B);const end=adapter.tools().find(tool=>tool.id==='browser.endTask')!;await end.execute({},new AbortController().signal);assert.equal(adapter.state(r.session)!.executionState,'COMPLETED');
  });await provider.close();
});
test('continuation never resumes from FAILED or WAITING state, even if an old ready token exists',()=>{
  const messages:string[]=[];const continuation=new BrowserContinuation(async()=>({outcome:'OK',data:{completed:true}}),text=>messages.push(text));
  for(const executionState of ['FAILED','WAITING_ACCESS','WAITING_CONFIRMATION','WAITING_MANUAL'] as const)continuation.update({workflow:null,ready:id(),executionState},false);
  assert.equal(messages.length,0);continuation.update({workflow:null,ready:id(),executionState:'RUNNING'},false);assert.equal(messages.length,1);assert.match(messages[0]!,/sin acknowledgement/);
});

test('opt-in authorization diagnostics correlate policy/grant/post/backend/continuation/next READ without private metadata',async()=>{
 const rows:import('../diagnostics/popup.js').PopupTrace[]=[];const diagnostics=new PopupDiagnostics(row=>rows.push(row));diagnostics.enabled=true;const r=runtime(diagnostics);await r.reset();r.store.permissions.add(hostPattern(A));const provider=new AttachedChromeProvider(r.transport,true,undefined,undefined,diagnostics);const correlation=id();const notifications:string[]=[];
 try{await provider.inSession(r.session,async()=>{
  const pending:any=await provider.requestTabAccess({target:{kind:'current'},purpose:'Fixture',lifetime:'task'},new AbortController().signal);await r.controller.approve(pending.accessRequestId,A,true,correlation);
  const continuation=new BrowserContinuation(async()=>({outcome:'OK',data:{completed:true}}),message=>notifications.push(message),diagnostics);continuation.update({...provider.state(r.session),executionState:'RUNNING',taskActive:true,revision:1},false);await provider.observe(new AbortController().signal);
  for(const stage of ['policy_saved','grant_created','notification_posted','backend_received','continuation_sent','next_task_tool'])assert.ok(rows.some(row=>row.stage===stage&&row.correlationId===correlation),stage);
  assert.ok(!JSON.stringify(rows).includes(A));assert.ok(rows.every(row=>Object.keys(row).every(key=>['correlationId','stage','outcome','durationMs'].includes(key))));assert.equal(notifications.length,1);
 });}finally{await provider.close();}
});
