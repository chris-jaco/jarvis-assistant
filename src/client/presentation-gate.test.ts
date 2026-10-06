import test from 'node:test';
import assert from 'node:assert/strict';
import { PresentationGate } from '../provider/presentation-gate.js';
function fixture(){const mutes:boolean[]=[];const gate=new PresentationGate(muted=>mutes.push(muted));return {gate,mutes};}
test('RUNNING suppresses audio and visible assistant text without stopping tools or internal continuation',()=>{
 const {gate,mutes}=fixture();gate.beginBrowser();gate.response('work');gate.item('work','narration');gate.playback('work');assert.equal(mutes.at(-1),true);assert.equal(gate.visible('narration'),false);gate.tool();assert.equal(gate.done('work'),false);gate.internal('continuation');assert.equal(gate.userVisible('continuation'),false);assert.equal(gate.userVisible('real-user'),true);
});
for(const state of ['WAITING_ACCESS','WAITING_CONFIRMATION','WAITING_MANUAL','COMPLETED','FAILED'] as const)test(`${state} allows fresh response output, never a previously suppressed response`,()=>{
 const {gate,mutes}=fixture();gate.beginBrowser();gate.response('old');gate.item('old','hidden');gate.update(state);gate.playback('old');assert.equal(mutes.at(-1),true);assert.equal(gate.visible('hidden'),false);gate.response('fresh');assert.equal(mutes.at(-1),true);gate.item('fresh','visible');gate.playback('fresh');assert.equal(mutes.at(-1),false);assert.equal(gate.visible('visible'),true);gate.playback('old');assert.equal(mutes.at(-1),true);
});
test('task admission suppresses pre-tool narration; browser tool routes to silent RUNNING, not ordinary output',()=>{
 const {gate,mutes}=fixture();gate.response('admission');gate.item('admission','first-ack');gate.playback('admission');assert.equal(mutes.at(-1),true);gate.tool();gate.beginBrowser();assert.equal(gate.done('admission'),false);gate.response('next-tool');gate.playback('next-tool');assert.equal(mutes.at(-1),true);assert.equal(gate.visible('first-ack'),false);
});
test('ordinary turn receives one fresh answer after admission; suppressed output is never replayed',()=>{
 const {gate,mutes}=fixture();gate.response('routing');gate.item('routing','hidden');assert.equal(gate.done('routing'),true);gate.response('answer');gate.item('answer','visible');gate.playback('answer');assert.equal(mutes.at(-1),false);assert.equal(gate.visible('hidden'),false);assert.equal(gate.visible('visible'),true);assert.equal(gate.done('answer'),false);gate.turn();gate.playback('answer');assert.equal(mutes.at(-1),true);
});
test('tool success does not complete browser task, and confirmation speech turn does not reset its output eligibility',()=>{
 const {gate,mutes}=fixture();gate.beginBrowser();gate.response('tool');gate.tool();gate.done('tool');gate.response('result');gate.playback('result');assert.equal(mutes.at(-1),true);gate.update('WAITING_CONFIRMATION');gate.turn(true);gate.response('prompt');gate.playback('prompt');assert.equal(mutes.at(-1),false);
});

test('real VoiceToolBridge keeps tools/internal continuation operational and carries known execution through a later READ error',async()=>{
 const {VoiceToolBridge}=await import('../provider/tools.js');const {RunContext}=await import('@openai/agents-core');const original=globalThis.fetch;const {gate,mutes}=fixture();const calls:string[]=[];let revision=1;const outcome={actionId:crypto.randomUUID(),execution:'EXECUTED',verification:'FAILED',outcome:'ACTION_EXECUTED_UNVERIFIED'};let state='RUNNING';
 globalThis.fetch=async(path,options)=>{const url=String(path);if(url.endsWith('/session'))return options?.method==='DELETE'?Response.json({}):Response.json({tools:[{id:'browser.type',description:'Fixture',inputSchema:{}},{id:'browser.observe',description:'Fixture',inputSchema:{}}],timezone:'Europe/Madrid',now:new Date().toISOString()});
 if(url.endsWith('/invoke')){const body=JSON.parse(String(options!.body));calls.push(body.toolId);++revision;if(body.toolId==='browser.observe'){state='FAILED';return Response.json({status:'error',category:'UPSTREAM',message:'No se pudo obtener información externa.',browserExecutionState:state,browserActionOutcome:outcome,browserTaskActive:true,browserRevision:revision});}return Response.json({status:'success',data:{action:{status:'COMPLETED'},observation:{status:'FAILED',reason:'UPSTREAM'}},browserExecutionState:state,browserActionOutcome:outcome,browserTaskActive:true,browserRevision:revision});}
 if(url.endsWith('/activity'))return Response.json({activity:[],pending:null,browser:{workflow:null,ready:null,actionOutcome:outcome,executionState:state,taskActive:true,revision}});throw new Error('unexpected fixture request');};
 const bridge=new VoiceToolBridge(()=>{},()=>{},undefined,undefined,{state:state=>gate.update(state),tool:browser=>{gate.tool();if(browser)gate.beginBrowser();}});
 try{const config=await bridge.initialize();gate.response('routing');const first:any=await config.tools[0]!.invoke(new RunContext(),JSON.stringify({inputJson:'{}'}));assert.match(first.instruction,/acción fue ejecutada/);gate.response('running');gate.playback('running');assert.equal(mutes.at(-1),true);const failed:any=await config.tools[1]!.invoke(new RunContext(),JSON.stringify({inputJson:'{}'}));assert.equal(failed.browserActionOutcome.execution,'EXECUTED');assert.match(failed.message,/acción fue ejecutada/);assert.deepEqual(calls,['browser.type','browser.observe']);gate.response('failed-report');gate.playback('failed-report');assert.equal(mutes.at(-1),false);}
 finally{bridge.close();globalThis.fetch=original;}
});

test('duplicate response-created cannot release hidden output; late previous-turn completion cannot admit stale audio',()=>{
 const {gate,mutes}=fixture();gate.response('old-turn');gate.item('old-turn','hidden');gate.turn();assert.equal(gate.done('old-turn'),false);gate.beginBrowser();gate.response('work');gate.item('work','narration');gate.update('WAITING_ACCESS');gate.response('work');gate.playback('work');assert.equal(mutes.at(-1),true);assert.equal(gate.visible('narration'),false);
});

test('response cache eviction preserves legitimate transcript and cannot resurrect hidden items',()=>{
 const {gate}=fixture();gate.response('routing');gate.done('routing');gate.response('answer');gate.item('answer','visible');gate.done('answer');gate.beginBrowser();gate.response('hidden');gate.item('hidden','hidden-item');gate.done('hidden');for(let i=0;i<300;i++){gate.response('work-'+i);gate.done('work-'+i);}assert.equal(gate.visible('visible'),true);assert.equal(gate.visible('hidden-item'),false);gate.update('COMPLETED');gate.response('hidden');gate.item('hidden','hidden-item');assert.equal(gate.visible('hidden-item'),false);
});
