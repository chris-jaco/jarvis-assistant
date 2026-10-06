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
