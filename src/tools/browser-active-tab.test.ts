import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolveActiveTab, resolvePopupActiveTab, type ActiveTab } from '../../extension/src/active-tab.js';
import { ExtensionController, type Surface } from '../../extension/src/controller.js';
import { AttachedChromeProvider } from '../browser/attached/provider.js';
import { ToolError } from './types.js';
const tab:ActiveTab={id:7,windowId:11,url:'https://fixture.example/',title:'Private fixture title'};
test('active tab resolution: zero candidates fails specifically',async()=>{
 await assert.rejects(resolveActiveTab(async()=>[]),/ACTIVE_TAB_UNAVAILABLE/);
});
test('active tab resolution: one candidate preserves its explicit identity',async()=>{
 assert.deepEqual(await resolveActiveTab(async()=>[tab]),{id:7,url:tab.url,title:tab.title});
});
for(const tabs of [[tab,{...tab,id:8,windowId:12}],[{...tab,id:8,windowId:12},tab],[tab,{...tab,id:8}]])test('multiple candidates never select by order, origin, permission or window',async()=>{
 await assert.rejects(resolveActiveTab(async()=>tabs),/ACTIVE_TAB_AMBIGUOUS/);
});
for(const bad of [{...tab,id:undefined},{...tab,url:undefined},{...tab,windowId:-1}])test('incomplete candidate fails closed',async()=>{
 await assert.rejects(resolveActiveTab(async()=>[bad]),/ACTIVE_TAB_UNAVAILABLE/);
});
test('Chrome query errors are sanitized',async()=>{
 await assert.rejects(resolveActiveTab(async()=>{throw new Error('private details');}),e=>e instanceof Error&&e.message==='ACTIVE_TAB_UNAVAILABLE');
});
test('popup resolves only the active tab in its authenticated originating window',async()=>{
 const all=[tab,{...tab,id:8,windowId:12,url:'https://other.example/'}];let queried:number|undefined;
 const selected=await resolvePopupActiveTab(11,async windowId=>{queried=windowId;return all.filter(candidate=>candidate.windowId===windowId);});
 assert.equal(queried,11);assert.equal(selected.id,7);assert.equal(selected.url,tab.url);
});
test('popup window context fails closed when absent, invalid, ambiguous or mismatched',async()=>{
 for(const windowId of [-1,Number.NaN])await assert.rejects(resolvePopupActiveTab(windowId,async()=>[tab]),/ACTIVE_TAB_UNAVAILABLE/);
 await assert.rejects(resolvePopupActiveTab(11,async()=>[]),/ACTIVE_TAB_UNAVAILABLE/);
 await assert.rejects(resolvePopupActiveTab(11,async()=>[tab,{...tab,id:9}]),/ACTIVE_TAB_AMBIGUOUS/);
 await assert.rejects(resolvePopupActiveTab(11,async()=>[{...tab,windowId:12}]),/ACTIVE_TAB_UNAVAILABLE/);
});
for(const candidates of [[],[tab,{...tab,id:8,windowId:12}]])test('selection failure propagates through controller and provider without grant, pending ticket, effect or private details',async()=>{
 const epoch=randomUUID(),connection=randomUUID();let effects=0;const events:unknown[]=[];
 const effect=async()=>{++effects;throw new Error('must not execute');};
 const surface:Surface={current:()=>resolveActiveTab(async()=>candidates),create:effect,activate:effect,navigate:effect,history:effect,content:effect,invalidate:effect};
 const controller=new ExtensionController(surface,event=>events.push(event),Date.now,randomUUID,{allows:async()=>true,allowAlways:effect});
 await controller.reset({protocol:'atlas.browser',version:1,kind:'hello',connectionEpoch:epoch});
 const code=candidates.length?'ACTIVE_TAB_AMBIGUOUS':'ACTIVE_TAB_UNAVAILABLE';
 const provider=new AttachedChromeProvider({close:async()=>{},epoch,connections:()=>[connection],subscribe:()=>()=>{},request:async(_,request)=>controller.receive(request)});
 await provider.inSession(randomUUID(),async()=>{
  await assert.rejects(provider.requestTabAccess({target:{kind:'current'},purpose:'Read only',lifetime:'task'},new AbortController().signal),e=>e instanceof ToolError&&e.category===(candidates.length?'AMBIGUOUS':'REJECTED')&&e.browserObservation?.status==='FAILED'&&e.browserObservation.reason===code);
 });
 assert.equal(controller.authorized().length,0);assert.equal(controller.pending().length,0);assert.equal(events.length,0);assert.equal(effects,0);
});
test('backend selection stays globally fail-closed while popup uses its authenticated window',async()=>{
 const source=await readFile('extension/src/service-worker.ts','utf8');
 assert.equal(source.includes('currentWindow'),false);
 assert.equal(source.match(/resolveActiveTab\(\(\) => chrome.tabs.query\(\{ active: true \}\)\)/g)?.length,1);
 assert.match(source,/resolvePopupActiveTab/);assert.match(source,/chrome\.tabs\.query\(\{active:true,windowId\}\)/);
});
test('popup-selected tab cannot approve a ticket bound to another window tab',async()=>{
 let candidates:ActiveTab[]=[tab];let effects=0;const epoch=randomUUID();
 const effect=async()=>{++effects;throw new Error('must not execute');};
 const controller=new ExtensionController({current:()=>resolveActiveTab(async()=>candidates),create:effect,activate:effect,navigate:effect,history:effect,content:effect,invalidate:effect},()=>{});
 await controller.reset({protocol:'atlas.browser',version:1,kind:'hello',connectionEpoch:epoch});
 const reply=await controller.receive({protocol:'atlas.browser',version:1,kind:'request',requestId:randomUUID(),backendSessionId:randomUUID(),taskId:randomUUID(),connectionEpoch:epoch,deadlineAt:Date.now()+17000,operation:'requestTabAccess',args:{target:{kind:'current'},purpose:'Read only',lifetime:'task'}});
 assert.equal(reply.outcome,'ACCESS_PENDING');
 await controller.preparePending({id:7,url:tab.url!,title:tab.title!});
 await assert.rejects(controller.approve(controller.pending()[0]!.id,undefined,false,undefined,{id:8,url:'https://other.example/',title:''}),/ACCESS_DENIED/);
 assert.equal(controller.authorized().length,0);assert.equal(effects,0);
});
test('popup approval re-resolves active candidates and cannot grant after ambiguity appears',async()=>{
 let candidates:ActiveTab[]=[tab];let effects=0;const epoch=randomUUID();
 const effect=async()=>{++effects;throw new Error('must not execute');};
 const controller=new ExtensionController({current:()=>resolveActiveTab(async()=>candidates),create:effect,activate:effect,navigate:effect,history:effect,content:effect,invalidate:effect},()=>{});
 await controller.reset({protocol:'atlas.browser',version:1,kind:'hello',connectionEpoch:epoch});
 const reply=await controller.receive({protocol:'atlas.browser',version:1,kind:'request',requestId:randomUUID(),backendSessionId:randomUUID(),taskId:randomUUID(),connectionEpoch:epoch,deadlineAt:Date.now()+17000,operation:'requestTabAccess',args:{target:{kind:'current'},purpose:'Read only',lifetime:'task'}});
 assert.equal(reply.outcome,'ACCESS_PENDING');
 candidates=[tab,{...tab,id:8,windowId:12}];
 await assert.rejects(controller.approve(controller.pending()[0]!.id),/ACTIVE_TAB_AMBIGUOUS/);
 assert.equal(controller.authorized().length,0);assert.equal(effects,0);
});
