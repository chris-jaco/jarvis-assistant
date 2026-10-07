import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserContinuation } from '../provider/browser-continuation.js';
import { VoiceToolBridge } from '../provider/tools.js';
import { RunContext } from '@openai/agents-core';

test('context-ready continuation is independent of access ready, once per recovery and respects in-flight result ownership',()=>{
  const notices:string[]=[];const continuation=new BrowserContinuation(async()=>({}),message=>notices.push(message));const actionOutcome={actionId:crypto.randomUUID(),execution:'EXECUTED',outcome:'ACTION_EXECUTED_UNVERIFIED',verification:'INCONCLUSIVE'};
  const state={workflow:null,ready:null,taskActive:true,executionState:'RUNNING',actionOutcome,contextRecovery:{status:'READY',attempts:1,ready:crypto.randomUUID()},revision:1};
  continuation.update(state,false);assert.equal(notices.length,1);assert.match(notices[0]!,/siguiente paso distinto/);continuation.update({...state,revision:2},false);assert.equal(notices.length,1);
  continuation.update({...state,contextRecovery:{...state.contextRecovery,ready:crypto.randomUUID()},revision:3},false,true);assert.equal(notices.length,1);continuation.update({...state,revision:2},false);assert.equal(notices.length,1);
  const blocked=new BrowserContinuation(async()=>({}),message=>notices.push(message));blocked.update({...state,executionState:'INCONCLUSIVE'},false);assert.equal(notices.length,1);blocked.close();continuation.close();
});

test('HTTP failure reconciles backend execution/context state instead of inventing TASK FAILED',async()=>{
  const original=globalThis.fetch;const states:string[]=[];const calls:string[]=[];const actionOutcome={actionId:crypto.randomUUID(),execution:'EXECUTED',outcome:'ACTION_EXECUTED_UNVERIFIED',verification:'FAILED'};
  globalThis.fetch=async(path,opts)=>{const route=String(path);calls.push(route);if(route.endsWith('/session'))return Response.json({tools:[{id:'browser.type',description:'Fixture',inputSchema:{}}],timezone:'Europe/Madrid',now:new Date().toISOString()});if(route.endsWith('/invoke'))throw new Error('PRIVATE_TRANSPORT');if(route.endsWith('/activity'))return Response.json({activity:[],pending:null,browser:{workflow:null,ready:null,executionState:'RECOVERING_CONTEXT',taskActive:true,revision:1,actionOutcome,contextRecovery:{status:'RECOVERING',attempts:0,ready:null}}});throw new Error();};
  const bridge=new VoiceToolBridge(()=>{},()=>{},undefined,undefined,{state:s=>states.push(s),tool:()=>{}});
  try{const config=await bridge.initialize();const result:any=await config.tools[0]!.invoke(new RunContext(),JSON.stringify({inputJson:'{}'}));assert.equal(result.browserActionOutcome.execution,'EXECUTED');assert.equal(result.browserExecutionState,'RECOVERING_CONTEXT');assert.ok(!states.includes('FAILED'));assert.match(result.message,/No la repitas/);assert.equal(calls.filter(route=>route.endsWith('/invoke')).length,1);assert.ok(!JSON.stringify(result).includes('PRIVATE'));}finally{bridge.close();globalThis.fetch=original;}
});

test('simultaneous access and context-ready tokens produce one continuation and are both consumed',()=>{
  const notices:string[]=[];const continuation=new BrowserContinuation(async()=>({}),message=>notices.push(message));
  const state={workflow:null,ready:crypto.randomUUID(),executionState:'RUNNING',taskActive:true,contextRecovery:{status:'READY',attempts:1,ready:crypto.randomUUID()},revision:1};
  continuation.update(state,false);assert.equal(notices.length,1);continuation.update({...state,revision:2},false);assert.equal(notices.length,1);continuation.close();
});

test('access received during a tool is pending, then delivered exactly once at release',()=>{
 const messages:string[]=[];const c=new BrowserContinuation(async()=>({}),m=>messages.push(m));const state={taskId:crypto.randomUUID(),workflow:null,ready:crypto.randomUUID(),executionState:'RUNNING',revision:1};
 c.update(state,false,true);assert.equal(messages.length,0);assert.equal(c.receipt()!.tokens.length,1);c.released();assert.equal(messages.length,1);assert.deepEqual(c.receipt()!.tokens,[]);c.released();c.update({...state,revision:2},false);assert.equal(messages.length,1);
});
test('deferred access and READ recovery coalesce, SDK committed receipt prevents any duplicate',()=>{
 for(const incorporated of [false,true]){const messages:string[]=[];const c=new BrowserContinuation(async()=>({}),m=>messages.push(m));const state={taskId:crypto.randomUUID(),workflow:null,ready:crypto.randomUUID(),contextRecovery:{status:'READY',attempts:1,ready:crypto.randomUUID()},executionState:'RUNNING',revision:1};
 c.update(state,false,true);assert.equal(c.receipt()!.tokens.length,2);if(incorporated)c.committed(c.receipt());else c.released();assert.equal(messages.length,incorporated?0:1);c.released();c.update({...state,revision:2},false);assert.equal(messages.length,incorporated?0:1);}
});
test('wrong task/token receipts cannot consume pending work; task restart discards old work',()=>{
 const messages:string[]=[];const c=new BrowserContinuation(async()=>({}),m=>messages.push(m));const taskId=crypto.randomUUID();const state={taskId,workflow:null,ready:crypto.randomUUID(),executionState:'RUNNING',revision:1};c.update(state,false,true);
 c.committed({taskId:crypto.randomUUID(),tokens:[state.ready]},true);assert.equal(c.receipt()!.tokens.length,1);c.update({...state,taskId:crypto.randomUUID(),ready:null,revision:2},false,true);c.released();assert.equal(messages.length,0);
});
test('token lifecycle diagnostics cover deferred RECEIVED/PENDING/DELIVERED/CONSUMED without private data',async()=>{
 const {BrowserTaskDiagnostics}=await import('../diagnostics/browser-task.js');const rows:import('../diagnostics/browser-task.js').BrowserTaskTrace[]=[];const d=new BrowserTaskDiagnostics(row=>rows.push(row));d.enabled=true;
 const c=new BrowserContinuation(async()=>({}),()=>{},undefined,d);c.update({taskId:crypto.randomUUID(),workflow:null,ready:crypto.randomUUID(),executionState:'RUNNING'},false,true);assert.deepEqual(rows.filter(r=>r.stage==='CONTINUATION').map(r=>r.tokenState),['RECEIVED','PENDING']);c.committed(c.receipt());assert.deepEqual(rows.filter(r=>r.stage==='CONTINUATION').map(r=>r.tokenState),['RECEIVED','PENDING','DELIVERED','CONSUMED']);
});

test('real VoiceToolBridge keeps deferred tokens until SDK commits the exact output, without an extra response',async()=>{
 const original=globalThis.fetch,taskId=crypto.randomUUID(),token=crypto.randomUUID(),recovery=crypto.randomUUID();const messages:string[]=[];const receipts:unknown[]=[];let revision=1;
 const state={taskId,workflow:null,ready:token,executionState:'RUNNING',taskActive:true,contextRecovery:{status:'READY',attempts:1,ready:recovery},continuation:{taskId,tokens:[token,recovery]}};
 globalThis.fetch=async(path,opts)=>{
  if(String(path).endsWith('/session'))return Response.json({tools:[{id:'browser.observe',description:'Fixture',inputSchema:{}}],timezone:'Europe/Madrid',now:new Date().toISOString()});
  // Simulate the access event arriving after the HTTP snapshot, during refresh.
  if(String(path).endsWith('/invoke'))return Response.json({status:'success',data:{},browserExecutionState:'RUNNING',browserRevision:1,browserTaskActive:true,browserContinuation:{taskId,tokens:[]}});
  if(String(path).endsWith('/activity'))return Response.json({activity:[],pending:null,browser:{...state,revision:++revision}});
  if(String(path).endsWith('/browser-continuation')){receipts.push(JSON.parse(String(opts!.body)));return Response.json({acknowledged:true});}throw new Error();
 };
 const bridge=new VoiceToolBridge(()=>{},m=>messages.push(m));
 try{
  const config=await bridge.initialize();const callId='call_fixture';const output:any=await config.tools[0]!.invoke(new RunContext(),JSON.stringify({inputJson:'{}'}),{toolCall:{type:'function_call',callId,name:'browser_observe',arguments:'{}'}});
  assert.equal(messages.length,0);assert.deepEqual(output.browserContinuation,{taskId,tokens:[token,recovery]});
  bridge.toolOutputCommitted(callId,JSON.stringify(output));await new Promise(resolve=>setTimeout(resolve,0));assert.equal(receipts.length,1);assert.equal(messages.length,0);
  bridge.toolOutputCommitted(callId,JSON.stringify(output));assert.equal(messages.length,0);await bridge.transportEvent({type:'response.done',response:{id:'resp_fixture',status:'completed'}});assert.equal(messages.length,0);
 }finally{bridge.close();globalThis.fetch=original;}
});

test('late access event waits for SDK next decision instead of creating a parallel response',async()=>{
 const original=globalThis.fetch,taskId=crypto.randomUUID(),token=crypto.randomUUID();const messages:string[]=[];let late=false;let polled=false;
 globalThis.fetch=async(path)=>{
  if(String(path).endsWith('/session'))return Response.json({tools:[{id:'browser.observe',description:'Fixture',inputSchema:{}}],timezone:'Europe/Madrid',now:new Date().toISOString()});
  if(String(path).endsWith('/invoke'))return Response.json({status:'success',data:{},browserExecutionState:'RUNNING',browserRevision:1,browserTaskActive:true,browserContinuation:{taskId,tokens:[]}});
  if(String(path).endsWith('/activity')){if(late)polled=true;return Response.json({activity:[],pending:null,browser:{taskId,workflow:null,ready:late?token:null,executionState:'RUNNING',revision:late?2:1,taskActive:true,continuation:{taskId,tokens:late?[token]:[]}}});}
  if(String(path).endsWith('/browser-continuation'))return Response.json({acknowledged:true});throw new Error();
 };
 const bridge=new VoiceToolBridge(()=>{},m=>messages.push(m));
 try{const config=await bridge.initialize();const callId='call_late';const output=await config.tools[0]!.invoke(new RunContext(),JSON.stringify({inputJson:'{}'}),{toolCall:{type:'function_call',callId,name:'browser_observe',arguments:'{}'}});
  bridge.toolOutputCommitted(callId,JSON.stringify(output));late=true;await new Promise(resolve=>setTimeout(resolve,1100));assert.equal(polled,true);assert.equal(messages.length,0);
  await bridge.transportEvent({type:'response.created',response:{id:'resp_next'}});assert.equal(messages.length,0);await bridge.transportEvent({type:'response.done',response:{id:'resp_next',status:'completed'}});assert.equal(messages.length,1);
  await bridge.transportEvent({type:'response.done',response:{id:'resp_next',status:'completed'}});assert.equal(messages.length,1);
 }finally{bridge.close();globalThis.fetch=original;}
});
test('failed continuation delivery remains pending rather than being falsely consumed',()=>{
 let fails=true,calls=0;const c=new BrowserContinuation(async()=>({}),()=>{++calls;if(fails)throw new Error('transport unavailable');});c.update({taskId:crypto.randomUUID(),workflow:null,ready:crypto.randomUUID(),executionState:'RUNNING'},false,true);c.released();assert.equal(c.receipt()!.tokens.length,1);fails=false;c.released();assert.equal(c.receipt()!.tokens.length,0);assert.equal(calls,2);c.released();assert.equal(calls,2);
});

test('explicit user cancellation is not erased by pending initial/new task admission',async()=>{
 const original=globalThis.fetch;const taskId=crypto.randomUUID();let cancelled=false,admissions=0;
 globalThis.fetch=async(path,opts)=>{
  if(String(path).endsWith('/session'))return Response.json({browserTaskLifecycle:true,tools:[{id:'browser.endTask',description:'Fixture',inputSchema:{}}],timezone:'Europe/Madrid',now:new Date().toISOString()});
  if(String(path).endsWith('/browser-cancel')){cancelled=true;return Response.json({cancelled:true});}
  if(String(path).endsWith('/browser-admit')){++admissions;cancelled=false;return Response.json({admitted:true});}
  if(String(path).endsWith('/invoke')){assert.equal(JSON.parse(String(opts!.body)).input.reason,'CANCELLED');return Response.json({status:'success',data:{outcome:cancelled?'END_TASK_ACCEPTED':'END_TASK_REJECTED',reason:'CANCELLED'},browserExecutionState:cancelled?'COMPLETED':'RUNNING',browserTaskActive:true,browserRevision:1});}
  if(String(path).endsWith('/activity'))return Response.json({activity:[],pending:null,browser:{taskId,workflow:null,ready:null,executionState:'COMPLETED',revision:1,taskActive:true,continuation:{taskId,tokens:[]}}});throw new Error();
 };
 const bridge=new VoiceToolBridge(()=>{},()=>{});
 try{const config=await bridge.initialize();bridge.speechStarted('user_cancel');await bridge.transcript('user_cancel','Atlas, cancelá la tarea del navegador.');const result:any=await config.tools[0]!.invoke(new RunContext(),JSON.stringify({inputJson:JSON.stringify({reason:'CANCELLED'})}));assert.equal(result.data.outcome,'END_TASK_ACCEPTED');assert.equal(admissions,0);}
 finally{bridge.close();globalThis.fetch=original;}
});

test('real bridge admits captured user text once before concurrent tools; model input cannot supply intent',async()=>{
 const original=globalThis.fetch;const admissions:any[]=[];let admitted=false;
 globalThis.fetch=async(path,opts)=>{
  const route=String(path);
  if(route.endsWith('/session'))return Response.json({browserTaskLifecycle:true,tools:[{id:'browser.observe',description:'Fixture',inputSchema:{}}],timezone:'Europe/Madrid',now:new Date().toISOString()});
  if(route.endsWith('/browser-admit')){admissions.push(JSON.parse(String(opts?.body)));await new Promise(resolve=>setTimeout(resolve,5));admitted=true;return Response.json({admitted:true});}
  if(route.endsWith('/invoke')){assert.equal(admitted,true);return Response.json({status:'success',data:{}});}
  if(route.endsWith('/activity'))return Response.json({activity:[],pending:null,browser:null});
  throw new Error('Unexpected route');
 };
 const bridge=new VoiceToolBridge(()=>{},()=>{});
 try{const config=await bridge.initialize();bridge.speechStarted('actual_user');const tool=config.tools[0]!;const pending=Promise.all([tool.invoke(new RunContext(),JSON.stringify({inputJson:'{"intent":"READ_ONLY"}'})),tool.invoke(new RunContext(),JSON.stringify({inputJson:'{}'}))]);await bridge.transcript('actual_user','Poné un set de música.');await pending;assert.equal(admissions.length,1);assert.deepEqual(admissions[0].userTurn,{itemId:'actual_user',utterance:'Poné un set de música.'});assert.equal(admissions[0].intent,undefined);}finally{bridge.close();globalThis.fetch=original;}
});
