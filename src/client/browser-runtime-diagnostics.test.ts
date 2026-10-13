import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserTaskDiagnostics, realtimeErrorFacts, type BrowserTaskTrace } from '../diagnostics/browser-task.js';
import { PresentationGate } from '../provider/presentation-gate.js';
import { BrowserContinuation } from '../provider/browser-continuation.js';
import { VoiceToolBridge } from '../provider/tools.js';
import { RunContext } from '@openai/agents-core';
const uuid=()=>crypto.randomUUID();
function trace(){const rows:BrowserTaskTrace[]=[];const diagnostic=new BrowserTaskDiagnostics(row=>rows.push(row));diagnostic.enabled=true;return {rows,diagnostic};}
test('Realtime error diagnostics accept only allowlisted facts and are disabled by default',()=>{
 const privateMessage='PRIVATE_SENTINEL';const error={name:'NetworkError',code:'ECONNRESET',message:privateMessage,stack:privateMessage,sdp:privateMessage};
 const {rows,diagnostic}=trace();diagnostic.event({stage:'REALTIME_SESSION_ERROR',...realtimeErrorFacts(error),connectionGeneration:2,elapsedMs:3500,sessionStage:'CONNECTED',transportState:'DISCONNECTED'});
 assert.equal(rows.length,1);assert.equal(rows[0]?.errorType,'NetworkError');assert.equal(rows[0]?.errorCode,'ECONNRESET');
 assert.deepEqual(realtimeErrorFacts({name:privateMessage,code:privateMessage,message:privateMessage}),{});
 assert.deepEqual(realtimeErrorFacts({type:'error',error:{type:'error',error:{type:'invalid_request_error',code:'conversation_already_has_active_response',message:privateMessage}}}),{errorType:'invalid_request_error',errorCode:'conversation_already_has_active_response'});
 diagnostic.event({stage:'REALTIME_SESSION_ERROR',errorType:privateMessage,connectionGeneration:2});
 diagnostic.event({stage:'REALTIME_SESSION_ERROR',message:privateMessage});assert.equal(rows.length,1);
 diagnostic.enabled=false;diagnostic.event({stage:'TOOLS_SESSION_DELETE',closeReason:'REALTIME_ERROR'});assert.equal(rows.length,1);
 assert.ok(!JSON.stringify(rows).includes(privateMessage));
});
test('manual diagnostic schema admits a known waiting reason and rejects private payloads',()=>{
 const {rows,diagnostic}=trace(),taskId=uuid(),manualRequestId=uuid();
 diagnostic.event({stage:'WORKFLOW',taskId,taskState:'WAITING_MANUAL',outcome:'REQUIRES_USER_INTERACTION',reason:'CONVERSATION_SELECTION'});
 diagnostic.event({stage:'MANUAL_REQUEST_CREATED',taskId,manualRequestId});
 diagnostic.event({stage:'MANUAL_EVENT_RECEIVED',taskId,manualRequestId,manualStatus:'SELECTED'});
 diagnostic.event({stage:'TOOLS_SESSION_DELETE',closeReason:'PAGEHIDE'});
 assert.equal(rows.length,4);
 diagnostic.event({stage:'MANUAL_EVENT_RECEIVED',taskId,manualRequestId,message:'PRIVATE_SENTINEL'});
 diagnostic.event({stage:'TOOLS_SESSION_DELETE',closeReason:'PRIVATE_SENTINEL'});
 assert.equal(rows.length,4);assert.ok(!JSON.stringify(rows).includes('PRIVATE_SENTINEL'));
});
test('tool session DELETE carries a closed reason only while diagnostics remain opt-in',async()=>{
 const originalFetch=globalThis.fetch,originalDebug=console.debug;const rows:BrowserTaskTrace[]=[],reasons:string[]=[];
 console.debug=(prefix,...args)=>{if(prefix==='[ATLAS browser task]')rows.push(JSON.parse(String(args[0])));};
 globalThis.fetch=async(_path,init)=>{
  if(init?.method==='DELETE'){reasons.push(new Headers(init.headers).get('X-Atlas-Session-Close')??'');return Response.json({closed:true});}
  return Response.json({tools:[],timezone:'Europe/Madrid',now:new Date().toISOString(),browserTrace:true});
 };
 try{const bridge=new VoiceToolBridge(()=>{},()=>{});await bridge.initialize();bridge.close('REALTIME_ERROR');await new Promise(resolve=>setTimeout(resolve,0));
  assert.deepEqual(reasons,['REALTIME_ERROR']);assert.equal(rows.filter(row=>row.stage==='TOOLS_SESSION_DELETE').length,1);assert.equal(rows.find(row=>row.stage==='TOOLS_SESSION_DELETE')?.closeReason,'REALTIME_ERROR');
  rows.length=0;globalThis.fetch=async(_path,init)=>{if(init?.method==='DELETE')return Response.json({closed:true});return Response.json({tools:[],timezone:'Europe/Madrid',now:new Date().toISOString(),browserTrace:false});};
  const disabled=new VoiceToolBridge(()=>{},()=>{});await disabled.initialize();disabled.close('REALTIME_ERROR');assert.equal(rows.length,0);
 }finally{globalThis.fetch=originalFetch;console.debug=originalDebug;}
});
test('runtime diagnostics reject payloads, unknown states, private IDs and sensitive nested fields; disabled/sink failures are inert',()=>{
 const {rows,diagnostic}=trace();const safe={stage:'ADMISSION',taskId:uuid(),admissionId:uuid(),intent:'ACTION_REQUIRED',source:'FALLBACK',taskState:'RUNNING'};
 diagnostic.event(safe);assert.equal(rows.length,1);assert.ok(rows[0]!.at);
 for(const field of ['transcript','prompt','url','headers','cookies','input','name','content','message'])diagnostic.event({...safe,[field]:'PRIVATE_SENTINEL'});
 for(const extra of [{source:'PRIVATE_SENTINEL'},{responseId:'PRIVATE_SENTINEL'},{tokenId:'PRIVATE_SENTINEL'},{guard:{url:'PRIVATE_SENTINEL'}},{status:'PRIVATE_SENTINEL'}])diagnostic.event({...safe,...extra});
 assert.equal(rows.length,1);diagnostic.enabled=false;diagnostic.event(safe);assert.equal(rows.length,1);
 const broken=new BrowserTaskDiagnostics(()=>{throw new Error('sink');});broken.enabled=true;assert.doesNotThrow(()=>broken.event(safe));assert.ok(!JSON.stringify(rows).includes('PRIVATE_SENTINEL'));
});
test('presentation diagnostic reasons and playback snapshots leave the original mute/eligibility sequence unchanged',()=>{
 const {rows,diagnostic}=trace();const plain:boolean[]=[],instrumented:boolean[]=[];
 const ordinary=new PresentationGate(v=>plain.push(v));const observed=new PresentationGate(v=>instrumented.push(v),diagnostic,()=>({visibility:'hidden',paused:false,ended:false}));
 for(const gate of [ordinary,observed]){gate.turn();gate.response('resp_ack');gate.item('resp_ack','ack');gate.playback('resp_ack');gate.playbackEvent('STARTED','resp_ack');gate.tool();gate.beginBrowser();gate.done('resp_ack');gate.response('resp_work');gate.playbackEvent('STOPPED','resp_ack');gate.playbackEvent('CLEARED','resp_ack');gate.turn();gate.response('resp_user');gate.item('resp_user','hidden');gate.playback('resp_user');assert.equal(gate.visible('hidden'),true);gate.close();}
 assert.deepEqual(instrumented,plain);assert.ok(rows.some(r=>r.responseId==='resp_work'&&r.muted===false&&r.muteReason==='RESPONSE_CREATED'));
 assert.deepEqual(rows.filter(r=>r.stage==='PLAYBACK').map(r=>r.playback),['STARTED','STOPPED','CLEARED']);assert.ok(rows.every(r=>r.visibility==='hidden'&&r.paused===false&&r.ended===false));
 const throwing=new PresentationGate(()=>{},diagnostic,()=>{throw new Error('private');});assert.doesNotThrow(()=>throwing.response('resp_safe'));
});
test('continuation diagnostics show opaque-token lifecycle, blocked cause, coalescing and SDK incorporation without additional decisions',()=>{
 const {rows,diagnostic}=trace();const taskId=uuid(),access=uuid(),recovery=uuid();let notifications=0;
 const c=new BrowserContinuation(async()=>({}),()=>++notifications,undefined,diagnostic,undefined,()=>({toolInFlight:true,sdkAwaitingResponse:true}));
 c.update({taskId,workflow:null,ready:access,executionState:'RUNNING',contextRecovery:{status:'READY',attempts:1,ready:recovery},continuation:{taskId,tokens:[access,recovery]}},false,true);
 assert.ok(rows.some(r=>r.stage==='CONTINUATION_BLOCKED'&&r.blockedBy==='TOOL_OR_RESPONSE_IN_FLIGHT'&&r.sdkAwaitingResponse));
 c.committed(c.receipt(),true);c.released();assert.equal(notifications,0);
 for(const token of [access,recovery])assert.deepEqual(rows.filter(r=>r.stage==='CONTINUATION'&&r.tokenId===token).map(r=>r.tokenState),['RECEIVED','PENDING','DELIVERED','CONSUMED']);
 assert.ok(rows.some(r=>r.coalesced));assert.ok(rows.some(r=>r.incorporatedBySdkOutput&&r.source==='SDK_OUTPUT'));c.close();
});
test('response request/created/output/done diagnostics contain booleans and opaque relations, never response text or arguments',async()=>{
 const originalFetch=globalThis.fetch,originalDebug=console.debug;const rows:BrowserTaskTrace[]=[];const token=uuid(),taskId=uuid();
 console.debug=(prefix,...args)=>{if(prefix==='[ATLAS browser task]')rows.push(JSON.parse(String(args[0])));};
 globalThis.fetch=async(path)=>{const route=String(path);if(route.endsWith('/session'))return Response.json({browserTrace:true,tools:[{id:'browser.observe',description:'Fixture',inputSchema:{}}],timezone:'Europe/Madrid',now:new Date().toISOString()});if(route.endsWith('/invoke'))return Response.json({status:'success',data:{},browserExecutionState:'RUNNING'});if(route.endsWith('/activity'))return Response.json({activity:[],pending:null,browser:{taskId,workflow:null,ready:token,executionState:'RUNNING',continuation:{taskId,tokens:[token]}}});if(route.endsWith('/browser-continuation'))return Response.json({acknowledged:true});throw new Error('unexpected');};
 const bridge=new VoiceToolBridge(()=>{},()=>{});
 try{const config=await bridge.initialize();const result=await config.tools[0]!.invoke(new RunContext(),JSON.stringify({inputJson:'{}'}),{toolCall:{callId:'call_safe',id:'item',name:'browser_observe',arguments:'{}',type:'function_call'}} as any);bridge.toolOutputCommitted('call_safe',JSON.stringify(result));
 await bridge.transportEvent({type:'response.created',response:{id:'resp_safe'}});await bridge.transportEvent({type:'response.output_item.added',response_id:'resp_safe',item:{type:'message',id:'item_safe',content:'PRIVATE_SENTINEL'}});await bridge.transportEvent({type:'response.output_item.added',response_id:'resp_safe',item:{type:'function_call',name:'browser_observe',call_id:'call_other',arguments:'PRIVATE_SENTINEL'}});await bridge.transportEvent({type:'response.done',response:{id:'resp_safe',status:'completed',output:[{type:'message',text:'PRIVATE_SENTINEL'}]}});
 assert.ok(rows.some(r=>r.stage==='RESPONSE_REQUESTED'&&r.source==='SDK_OUTPUT'&&r.tokens?.includes(token)));assert.ok(rows.some(r=>r.stage==='RESPONSE_CREATED'&&r.responseId==='resp_safe'));
 const done=rows.find(r=>r.stage==='RESPONSE_DONE');assert.equal(done?.status,'completed');assert.equal(done?.producedMessage,true);assert.equal(done?.producedFunctionCall,true);assert.ok(done?.tokens?.includes(token));assert.ok(!JSON.stringify(rows).includes('PRIVATE_SENTINEL'));
 }finally{bridge.close();globalThis.fetch=originalFetch;console.debug=originalDebug;}
});
