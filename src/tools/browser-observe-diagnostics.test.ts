import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID as id } from 'node:crypto';
import { observeTracer,observationFacts,observeTraceSchema } from '../diagnostics/browser-observe.js';
import { contentRequest } from '../../extension/src/content-transport.js';
import { SiteAuthorization } from '../../extension/src/site-authorization.js';
import { ExtensionController } from '../../extension/src/controller.js';
import { parseRequest } from '../browser/attached/protocol.js';
import type { Grant,Surface } from '../../extension/src/controller.js';
const epoch=id(),session=id(),task=id();
const grant:Grant={scopeId:id(),tabId:id(),chromeId:7,origin:'https://fixture.example',session,task,expiresAt:Date.now()+900000,lifetime:'task',title:'PRIVATE_TITLE',url:'https://fixture.example/private?q=PRIVATE_QUERY'};
const req=(trace=false)=>parseRequest({protocol:'atlas.browser',version:1,kind:'request',requestId:id(),backendSessionId:session,taskId:task,connectionEpoch:epoch,deadlineAt:Date.now()+17000,operation:'observe',args:{scopeId:grant.scopeId,tabId:grant.tabId},...(trace?{observeTrace:true}:{})});
const snapshot=()=>({tabId:grant.tabId,scopeId:grant.scopeId,documentId:id(),snapshotId:id(),expiresAt:Date.now()+15000,url:grant.url,title:grant.title,elements:[{ref:id(),role:'textbox',name:'PRIVATE_MESSAGE',type:'text',disabled:false,action:'search',capabilities:['TYPE_SEARCH']}],truncated:false});
test('observe traces default off, reject private fields/raw errors and bound structural counts',()=>{
 const rows:unknown[]=[];observeTracer(false,row=>rows.push(row))({stage:'OBSERVE_RESULT'});assert.equal(rows.length,0);
 const trace=observeTracer(true,row=>rows.push(row));trace({stage:'OBSERVE_RESULT',...observationFacts(snapshot()),snapshotValid:true});
 for(const payload of [{stage:'OBSERVE_AUTH',url:grant.url},{stage:'CONTENT_TRANSPORT',error:'PRIVATE_TOKEN'},{stage:'OBSERVE_RESULT',refCount:41},{stage:'OBSERVE_RESULT',capabilityCount:121},{stage:'WORKFLOW_TRANSITION',failureReason:'PRIVATE_MESSAGE'}])trace(payload);
 assert.equal(rows.length,1);assert.ok(!JSON.stringify(rows).includes('PRIVATE'));assert.doesNotThrow(()=>observeTracer(true,()=>{throw Error('PRIVATE');})({stage:'OBSERVE_RESULT'}));
});
for(const failure of ['none','injection','init','messaging','invalid'] as const)test(`content diagnostics identify ${failure} without altering commands or outcome`,async()=>{
 const run=async(trace:boolean)=>{const commands:string[]=[];let messages=0;const api:any={scripting:{executeScript:async()=>{commands.push('inject');if(failure==='injection')throw Error('PRIVATE_PATH');}},tabs:{update:async()=>commands.push('activate'),get:async()=>({url:grant.url}),sendMessage:async()=>{commands.push('message');if(++messages===1)return failure==='init'?{completed:false}:{completed:true};if(failure==='messaging')throw Error('PRIVATE_COOKIE');return failure==='invalid'?{outcome:'OK',data:{private:'PRIVATE'}}:{outcome:'OK',data:snapshot()};}}};return {commands,result:await contentRequest(api,()=>epoch,7,grant,req(trace))};};
 const plain=await run(false),traced=await run(true);assert.deepEqual(traced.commands,plain.commands);assert.equal(traced.result.outcome,plain.result.outcome);if(plain.result.outcome==='ERROR'&&traced.result.outcome==='ERROR')assert.equal(traced.result.code,plain.result.code);assert.equal(plain.result.observeTrace,undefined);assert.ok(traced.result.observeTrace?.length);assert.ok(!JSON.stringify(traced.result.observeTrace).includes('PRIVATE'));
 if(failure==='none')assert.ok(traced.result.observeTrace!.some(row=>row.reply==='RECEIVED'));if(failure==='invalid')assert.ok(traced.result.observeTrace!.some(row=>row.failureReason==='REPLY_INVALID'));
});
test('authorization diagnostic view separates stored ALLOW from Chrome permission without writes/reconciliation',async()=>{
 let permitted=true,writes=0,invalidations=0;const sites=new SiteAuthorization({load:async()=>({version:1,sites:[{origin:grant.origin,createdAt:0}]}),save:async()=>{++writes;},remove:async()=>{++writes;return true;},contains:async()=>permitted},async()=>{++invalidations;});
 assert.deepEqual(await sites.diagnosticStatus(grant.origin),{chromePermission:true,persistentPolicy:'ALLOW'});permitted=false;assert.deepEqual(await sites.diagnosticStatus(grant.origin),{chromePermission:false,persistentPolicy:'ALLOW'});assert.deepEqual(await sites.diagnosticStatus('https://another.example'),{chromePermission:false,persistentPolicy:'ASK'});assert.equal(writes,0);assert.equal(invalidations,0);
});
for(const state of ['present','missing','other-task','expired','revoked','other-origin'] as const)test(`OBSERVE_AUTH captures ${state} without changing enforcement`,async()=>{
 const run=async(trace:boolean)=>{let reads=0,probes=0;const surface:Surface={current:async()=>({id:7,url:grant.url,title:grant.title}),create:async()=>7,activate:async()=>{},navigate:async()=>{},history:async()=>{},invalidate:async()=>{},observeAuthorization:async()=>{++probes;return {chromePermission:true,persistentPolicy:'ALLOW',sameOrigin:state!=='other-origin'};},content:async()=>{++reads;return {outcome:'OK',data:snapshot()} as any;}};
 const c=new ExtensionController(surface,()=>{});await c.reset({protocol:'atlas.browser',version:1,kind:'hello',connectionEpoch:epoch});
 const access=parseRequest({...req(),operation:'requestTabAccess',args:{target:{kind:'current'},purpose:'Fixture',lifetime:'task'}});await c.receive(access);c.grants.set(grant.scopeId,{...grant,...(state==='other-task'?{task:id()}:{}),...(state==='expired'?{expiresAt:Date.now()-1}:{})});if(state==='missing')c.grants.clear();if(state==='revoked')await c.revoke(grant.scopeId);const reply=await c.receive(req(trace));return {reply,reads,probes};};
 const plain=await run(false),traced=await run(true);assert.equal(traced.reply.outcome,plain.reply.outcome);assert.equal(traced.reads,plain.reads);assert.equal(plain.probes,0);assert.equal(traced.probes,['present','other-origin'].includes(state)?1:0);assert.equal(plain.reply.observeTrace,undefined);const row=traced.reply.observeTrace?.find(row=>row.stage==='OBSERVE_AUTH');assert.ok(row);assert.equal(row.taskGrant,state==='missing'?'MISSING':state==='revoked'?'REVOKED':state==='expired'?'EXPIRED':state==='other-task'?'INCOMPATIBLE':'PRESENT');assert.ok(!JSON.stringify(traced.reply.observeTrace).includes('PRIVATE'));
});

import { AttachedChromeProvider } from '../browser/attached/provider.js';
import { BrowserDiagnostics } from '../browser/diagnostics.js';
import { BrowserTaskDiagnostics } from '../diagnostics/browser-task.js';
import { BrowserAdapter } from './adapters/browser.js';
import type { BrowserTransport } from '../browser/attached/transport.js';
for(const mode of ['valid','expired','no-content'] as const)test(`backend instrumentation captures ${mode}, no action replay and unchanged recovery outcome`,async()=>{
 const run=async(enabled:boolean)=>{const rows:any[]=[],operations:string[]=[];const original=console.info;console.info=(prefix,...args)=>{if(prefix==='[ATLAS browser observe]')rows.push(JSON.parse(args[0]));};
 const listeners:any[]=[];const connection=id();const tab={id:grant.tabId,scopeId:grant.scopeId,title:grant.title,url:grant.url,active:true,expiresAt:grant.expiresAt,state:'ACTIVE' as const};
 const transport:BrowserTransport={epoch,connections:()=>[connection],subscribe:listener=>{listeners.push(listener);return()=>{};},close:()=>{},request:async(_,request)=>{
 operations.push(request.operation);
 if(request.operation==='requestTabAccess'){listeners.forEach(listener=>listener(connection,{protocol:'atlas.browser',version:1,kind:'event',connectionEpoch:epoch,backendSessionId:session,event:'accessGranted',tab}));return {outcome:'OK',data:tab};}
 if(request.operation==='observe'){assert.equal(request.observeTrace===true,enabled);return mode==='no-content'?{outcome:'ERROR',code:'CONTENT_UNAVAILABLE'}:{outcome:'OK',data:{...snapshot(),...(mode==='expired'?{expiresAt:Date.now()-1}:{})}} as any;}
 return {outcome:'OK',data:{completed:true}};
 }};
 const diagnostics=new BrowserDiagnostics(enabled,()=>{});const provider=new AttachedChromeProvider(transport,true,undefined,diagnostics,undefined,new BrowserTaskDiagnostics(()=>{}));const adapter=new BrowserAdapter(provider,diagnostics,new BrowserTaskDiagnostics(()=>{}));
 try{return await adapter.inSession(session,async()=>{await provider.admitGoal(id(),'Buscá algo');await provider.openTab(grant.origin+'/',new AbortController().signal);const result:any=await adapter.tools().find(tool=>tool.id==='browser.observe')!.execute({},new AbortController().signal);return {rows,operations,state:adapter.state(session)!.executionState,result:result.observation?.status??'OK'};});}finally{await provider.close();console.info=original;}
 };
 const plain=await run(false),traced=await run(true);assert.deepEqual(traced.operations,plain.operations);assert.equal(traced.state,plain.state);assert.equal(traced.result,plain.result);assert.equal(plain.rows.length,0);assert.ok(traced.rows.some(row=>row.stage==='OBSERVE_RESULT'));assert.ok(!JSON.stringify(traced.rows).includes('PRIVATE'));assert.ok(traced.rows.every(row=>observeTraceSchema.safeParse(row).success));
 if(mode==='valid')assert.ok(traced.rows.some(row=>row.snapshotValid&&row.contextState==='READY'&&row.refCount===1&&row.bindingCoherent));else assert.ok(traced.rows.some(row=>row.stage==='WORKFLOW_TRANSITION'&&row.to==='INCONCLUSIVE'&&row.failureReason==='READ_BUDGET_EXHAUSTED'));
});

test('content transport pins init and observation to the injected Chrome document',async()=>{
 const documentId=id(),targets:any[]=[];let messages=0;
 const api:any={scripting:{executeScript:async()=>[{frameId:0,documentId}]},tabs:{update:async()=>{},get:async()=>({url:grant.url,status:'loading'}),sendMessage:async(_tab:any,_raw:any,target:any)=>{targets.push(target);return ++messages===1?{completed:true}:{outcome:'OK',data:snapshot()};}}};
 assert.equal((await contentRequest(api,()=>epoch,7,grant,req())).outcome,'OK');assert.deepEqual(targets,[{documentId},{documentId}]);
});
for(const operation of ['observe','click'] as const)test(`lost ${operation} document reply preserves READ vs action uncertainty`,async()=>{
 let messages=0;const api:any={scripting:{executeScript:async()=>[{frameId:0,documentId:id()}]},tabs:{update:async()=>{},get:async()=>({url:grant.url}),sendMessage:async()=>{if(++messages===1)return {completed:true};throw Error('PRIVATE_ERROR');}}};
 const request=operation==='observe'?req():parseRequest({...req(),operation:'click',args:{scopeId:grant.scopeId,tabId:grant.tabId,documentId:id(),snapshotId:id(),ref:id()}});
 const reply:any=await contentRequest(api,()=>epoch,7,grant,request);assert.equal(reply.code,operation==='observe'?'CONTENT_UNAVAILABLE':'EXECUTION_UNKNOWN');assert.equal(messages,2);
});
test('navigation begun during init prevents dispatch to a previous document',async()=>{
 let messages=0;const api:any={scripting:{executeScript:async()=>[{frameId:0,documentId:id()}]},tabs:{update:async()=>{},get:async()=>({url:grant.url,pendingUrl:grant.origin+'/next'}),sendMessage:async()=>{++messages;return {completed:true};}}};
 const request=parseRequest({...req(),operation:'click',args:{scopeId:grant.scopeId,tabId:grant.tabId,documentId:id(),snapshotId:id(),ref:id()}});
 const reply:any=await contentRequest(api,()=>epoch,7,grant,request);assert.equal(reply.conflict.reason,'DOCUMENT_CHANGED');assert.equal(reply.conflict.execution,'NOT_EXECUTED');assert.equal(messages,1);
});
