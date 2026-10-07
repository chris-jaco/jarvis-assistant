import test from 'node:test';
import assert from 'node:assert/strict';
import { PresentationGate } from '../provider/presentation-gate.js';
function fixture(){const mutes:boolean[]=[];const gate=new PresentationGate(muted=>mutes.push(muted));return {gate,mutes};}
test('RUNNING suppresses audio and visible assistant text without stopping tools or internal continuation',()=>{
 const {gate,mutes}=fixture();gate.beginBrowser();gate.response('work');gate.item('work','narration');gate.playback('work');assert.equal(mutes.at(-1),true);assert.equal(gate.visible('narration'),false);gate.tool();assert.equal(gate.done('work'),false);gate.internal('continuation');assert.equal(gate.userVisible('continuation'),false);assert.equal(gate.userVisible('real-user'),true);
});
for(const state of ['WAITING_ACCESS','WAITING_CONFIRMATION','WAITING_MANUAL','COMPLETED','FAILED','INCONCLUSIVE'] as const)test(`${state} allows fresh response output, never a previously suppressed response`,()=>{
 const {gate,mutes}=fixture();gate.beginBrowser();gate.response('old');gate.item('old','hidden');gate.update(state);gate.playback('old');assert.equal(mutes.at(-1),true);assert.equal(gate.visible('hidden'),false);gate.response('fresh');assert.equal(mutes.at(-1),true);gate.item('fresh','visible');gate.playback('fresh');assert.equal(mutes.at(-1),false);assert.equal(gate.visible('visible'),true);gate.playback('old');assert.equal(mutes.at(-1),true);
});
test('TASK_ACCEPTED allows exactly one initial acknowledgement without waiting to execute tools',()=>{
 const {gate,mutes}=fixture();gate.response('accept');gate.item('accept','ack');gate.playback('accept');assert.equal(mutes.at(-1),false);gate.tool();gate.beginBrowser();assert.equal(gate.visible('ack'),true);assert.equal(gate.done('accept'),false);gate.response('work');gate.item('work','narration');gate.playback('work');assert.equal(mutes.at(-1),true);assert.equal(gate.visible('narration'),false);gate.update('TASK_ACCEPTED');gate.response('duplicate-ack');gate.item('duplicate-ack','duplicate');assert.equal(gate.visible('duplicate'),false);
});
test('tool-first admission skips optional acknowledgement and never releases later narration',()=>{
 const {gate,mutes}=fixture();gate.response('accept');gate.tool();gate.beginBrowser();gate.item('accept','late-narration');gate.playback('accept');assert.equal(mutes.at(-1),true);assert.equal(gate.visible('late-narration'),false);assert.equal(gate.done('accept'),false);
});
test('ordinary turn answers directly without an extra response; barge-in invalidates old audio',()=>{
 const {gate,mutes}=fixture();gate.response('answer');gate.item('answer','visible');gate.playback('answer');assert.equal(mutes.at(-1),false);assert.equal(gate.visible('visible'),true);assert.equal(gate.done('answer'),false);gate.turn();gate.playback('answer');assert.equal(mutes.at(-1),true);gate.response('new');gate.item('new','new-visible');gate.playback('new');assert.equal(mutes.at(-1),false);
});
test('tool success does not complete browser task, and confirmation speech turn does not reset its output eligibility',()=>{
 const {gate,mutes}=fixture();gate.beginBrowser();gate.response('tool');gate.tool();gate.done('tool');gate.response('result');gate.playback('result');assert.equal(mutes.at(-1),true);gate.update('WAITING_CONFIRMATION');gate.turn(true);gate.response('prompt');gate.playback('prompt');assert.equal(mutes.at(-1),false);
});

test('real VoiceToolBridge keeps tools/internal continuation operational and carries known execution through a later READ error',async()=>{
 const {VoiceToolBridge}=await import('../provider/tools.js');const {RunContext}=await import('@openai/agents-core');const original=globalThis.fetch;const {gate,mutes}=fixture();const calls:string[]=[];let revision=1;const outcome={actionId:crypto.randomUUID(),execution:'EXECUTED',verification:'FAILED',outcome:'ACTION_EXECUTED_UNVERIFIED'};let state='RUNNING';
 globalThis.fetch=async(path,options)=>{const url=String(path);if(url.endsWith('/session'))return options?.method==='DELETE'?Response.json({}):Response.json({tools:[{id:'browser.type',description:'Fixture',inputSchema:{}},{id:'browser.observe',description:'Fixture',inputSchema:{}}],timezone:'Europe/Madrid',now:new Date().toISOString()});
 if(url.endsWith('/invoke')){const body=JSON.parse(String(options!.body));calls.push(body.toolId);++revision;if(body.toolId==='browser.observe'){state='RECOVERING_CONTEXT';return Response.json({status:'error',category:'UPSTREAM',message:'No se pudo obtener información externa.',browserExecutionState:state,browserActionOutcome:outcome,browserTaskActive:true,browserRevision:revision});}return Response.json({status:'success',data:{action:{status:'COMPLETED'},observation:{status:'FAILED',reason:'UPSTREAM'}},browserExecutionState:state,browserActionOutcome:outcome,browserTaskActive:true,browserRevision:revision});}
 if(url.endsWith('/activity'))return Response.json({activity:[],pending:null,browser:{workflow:null,ready:null,actionOutcome:outcome,executionState:state,taskActive:true,revision}});throw new Error('unexpected fixture request');};
 const bridge=new VoiceToolBridge(()=>{},()=>{},undefined,undefined,{state:state=>gate.update(state),tool:browser=>{gate.tool();if(browser)gate.beginBrowser();}});
 try{const config=await bridge.initialize();gate.response('routing');const first:any=await config.tools[0]!.invoke(new RunContext(),JSON.stringify({inputJson:'{}'}));assert.match(first.instruction,/acción fue ejecutada/);gate.response('running');gate.playback('running');assert.equal(mutes.at(-1),true);const failed:any=await config.tools[1]!.invoke(new RunContext(),JSON.stringify({inputJson:'{}'}));assert.equal(failed.browserActionOutcome.execution,'EXECUTED');assert.match(failed.message,/acción fue ejecutada/);assert.deepEqual(calls,['browser.type','browser.observe']);gate.response('recovering');gate.playback('recovering');assert.equal(mutes.at(-1),true);}
 finally{bridge.close();globalThis.fetch=original;}
});

test('duplicate response-created cannot release hidden output; late previous-turn completion cannot admit stale audio',()=>{
 const {gate,mutes}=fixture();gate.response('old-turn');gate.item('old-turn','hidden');gate.turn();assert.equal(gate.done('old-turn'),false);gate.beginBrowser();gate.response('work');gate.item('work','narration');gate.update('WAITING_ACCESS');gate.response('work');gate.playback('work');assert.equal(mutes.at(-1),true);assert.equal(gate.visible('narration'),false);
});

test('response cache eviction preserves legitimate transcript and cannot resurrect hidden items',()=>{
 const {gate}=fixture();gate.response('answer');gate.item('answer','visible');gate.done('answer');gate.beginBrowser();gate.response('hidden');gate.item('hidden','hidden-item');gate.done('hidden');for(let i=0;i<300;i++){gate.response('work-'+i);gate.done('work-'+i);}assert.equal(gate.visible('visible'),true);assert.equal(gate.visible('hidden-item'),false);gate.update('COMPLETED');gate.response('hidden');gate.item('hidden','hidden-item');assert.equal(gate.visible('hidden-item'),false);
});

test('RECOVERING_CONTEXT remains silent while tools and internal messages remain available',()=>{const {gate,mutes}=fixture();gate.update('RECOVERING_CONTEXT');gate.response('read');gate.item('read','hidden');gate.tool();gate.internal('context');gate.playback('read');assert.equal(mutes.at(-1),true);assert.equal(gate.visible('hidden'),false);gate.turn();gate.response('user-answer');gate.playback('user-answer');assert.equal(mutes.at(-1),false);gate.update('INCONCLUSIVE');gate.response('final');gate.item('final','final-text');gate.playback('final');assert.equal(mutes.at(-1),false);assert.equal(gate.userVisible('context'),false);});

test('non-browser tool-first turn still admits its fresh conversational result without admitting browser narration',()=>{
 const {gate,mutes}=fixture();gate.response('routing');gate.tool();gate.item('routing','premature');gate.playback('routing');assert.equal(mutes.at(-1),true);gate.done('routing');gate.response('tool-result');gate.item('tool-result','answer');gate.playback('tool-result');assert.equal(mutes.at(-1),false);assert.equal(gate.visible('answer'),true);
 gate.turn();gate.response('browser-routing');gate.tool();gate.beginBrowser();gate.done('browser-routing');gate.response('browser-result');gate.item('browser-result','hidden');gate.playback('browser-result');assert.equal(mutes.at(-1),true);
});
test('one accepted message cannot admit a second intermediate message in the same response',()=>{const {gate,mutes}=fixture();gate.response('accept');gate.item('accept','ack');gate.tool();gate.beginBrowser();gate.item('accept','intermediate');gate.playback('accept');assert.equal(gate.visible('ack'),true);assert.equal(gate.visible('intermediate'),false);assert.equal(mutes.at(-1),true);});

test('late tool events remain bound to their response, and ordinary permits cannot leak into RUNNING',()=>{const {gate,mutes}=fixture();gate.response('old');gate.tool();gate.done('old');gate.turn();gate.response('new');gate.item('old','old-function','function_call');gate.item('new','new-ack');assert.equal(gate.visible('new-ack'),true);gate.done('new');gate.beginBrowser();gate.response('work');gate.playback('work');assert.equal(mutes.at(-1),true);});

test('authorized acknowledgement owns playback while internal response and tools proceed',()=>{
 const {gate,mutes}=fixture();gate.turn();gate.response('ack');gate.item('ack','ack-item');gate.playback('ack');gate.playbackEvent('STARTED','ack');assert.equal(mutes.at(-1),false);
 gate.tool('ack');gate.beginBrowser();gate.done('ack');gate.response('internal');gate.item('internal','hidden-internal');gate.tool('internal');assert.equal(mutes.at(-1),false);assert.equal(gate.visible('hidden-internal'),false);
 gate.playbackEvent('STOPPED','ack');gate.playback('internal');assert.equal(mutes.at(-1),true);
});
for(const state of ['RUNNING','RECOVERING_CONTEXT','INCONCLUSIVE'] as const)test(`explicit user turn during ${state} is audible, next internal response is silent`,()=>{
 const {gate,mutes}=fixture();gate.update(state);gate.turn();gate.response('user-answer');gate.item('user-answer','answer');gate.playback('user-answer');assert.equal(mutes.at(-1),false);assert.equal(gate.visible('answer'),true);gate.playbackEvent('STOPPED','user-answer');gate.done('user-answer');gate.update('RUNNING');gate.response('continuation');gate.item('continuation','hidden');gate.playback('continuation');assert.equal(mutes.at(-1),true);assert.equal(gate.visible('hidden'),false);
});
test('queued internal continuation cannot consume the audible permit of a new explicit user turn',()=>{
 const {gate,mutes}=fixture();gate.update('RUNNING');gate.internal('internal-message');gate.turn();gate.response('internal-response',true);gate.item('internal-response','hidden');gate.playback('internal-response');assert.equal(mutes.at(-1),true);assert.equal(gate.visible('hidden'),false);
 gate.response('user-response');gate.item('user-response','answer');gate.playback('user-response');assert.equal(mutes.at(-1),false);assert.equal(gate.visible('answer'),true);
});
test('SDK internal response metadata separates notification from automatic user response without delaying tools',async()=>{
 const {OpenAIRealtimeWebRTC}=await import('@openai/agents-realtime');const events:any[]=[];
 const transport=Object.create(OpenAIRealtimeWebRTC.prototype) as InstanceType<typeof OpenAIRealtimeWebRTC>;transport.sendEvent=(event:any)=>{events.push(event);};
 // Exercise the SDK base serializer; live WebRTC owns its connected sequencer.
 transport.requestResponse=Object.getPrototypeOf(OpenAIRealtimeWebRTC.prototype).requestResponse;
 transport.sendMessage('internal fixture',{item:{id:'internal-item',type:'message',role:'user',content:[{type:'input_text',text:'internal fixture'}]}},{triggerResponse:false});transport.requestResponse({metadata:{atlas_presentation_source:'INTERNAL_BROWSER_CONTINUATION'}});
 assert.deepEqual(events.map(event=>event.type),['conversation.item.create','response.create']);assert.equal(events[1].response.metadata.atlas_presentation_source,'INTERNAL_BROWSER_CONTINUATION');
 const {gate,mutes}=fixture();gate.update('RUNNING');gate.turn();gate.response('internal',events[1].response.metadata.atlas_presentation_source==='INTERNAL_BROWSER_CONTINUATION');gate.item('internal','hidden');gate.playback('internal');assert.equal(mutes.at(-1),true);gate.tool('internal');gate.response('user');gate.item('user','answer');gate.playback('user');assert.equal(mutes.at(-1),false);
});
