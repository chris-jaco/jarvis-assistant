import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DESKTOP_CLEANUP_REQUEST_CHANNEL,
  DESKTOP_CLEANUP_RESULT_CHANNEL,
  DesktopCleanupProtocol,
  validDesktopCleanupResult,
  type DesktopCleanupResult
} from '../desktop/cleanup-protocol.js';
import { OpenAIVoiceProvider } from '../provider/openai.js';
import { VoiceToolBridge } from '../provider/tools.js';
import type { CoreTransport } from '../provider/core-transport.js';

const firstId='00000000-0000-4000-8000-000000000001';
const secondId='00000000-0000-4000-8000-000000000002';
const completed=(requestId=firstId):DesktopCleanupResult=>({requestId,status:'COMPLETED',local:{microphoneReleased:true,realtimeClosed:true,audioStopped:true},core:{state:'CLOSED',pendingConfirmationCancelled:true,execution:'IDLE'}});

function protocolFixture(){
  const listeners=new Map<string,(event:{sender:{id:number}},value:unknown)=>void>();
  const sent:unknown[]=[];let timer:(()=>void)|undefined;let cleared=0;
  const protocol=new DesktopCleanupProtocol(
    {on:(channel,listener)=>{listeners.set(channel,listener);},removeListener:channel=>{listeners.delete(channel);}},
    {send:(channel,request)=>{assert.equal(channel,DESKTOP_CLEANUP_REQUEST_CHANNEL);sent.push(request);}},
    sender=>sender===7,5000,()=>firstId,
    {setTimeout:callback=>{timer=callback;return 1;},clearTimeout:()=>{cleared++;}}
  );
  const reply=(sender:number,value:unknown)=>listeners.get(DESKTOP_CLEANUP_RESULT_CHANNEL)!({sender:{id:sender}},value);
  return {protocol,sent,reply,timeout:()=>timer?.(),listeners,cleared:()=>cleared};
}

test('desktop cleanup accepts one correlated trusted acknowledgment and coalesces duplicates',async()=>{
  const f=protocolFixture();const one=f.protocol.request('HIDE');const two=f.protocol.request('HIDE');
  assert.equal(one,two);assert.equal(f.sent.length,1);
  f.reply(7,completed());assert.deepEqual(await one,completed());
  f.reply(7,completed());assert.equal(f.cleared(),1);f.protocol.dispose();
});

test('desktop cleanup ignores stale, malformed and untrusted responses',async()=>{
  const f=protocolFixture();const pending=f.protocol.request('QUIT');let settled=false;void pending.then(()=>{settled=true;});
  f.reply(8,completed());f.reply(7,completed(secondId));f.reply(7,{requestId:firstId,status:'COMPLETED'});
  await Promise.resolve();assert.equal(settled,false);
  f.reply(7,completed());assert.equal((await pending).status,'COMPLETED');f.protocol.dispose();
});

test('desktop cleanup timeout is explicit and late acknowledgment cannot change it',async()=>{
  const f=protocolFixture();const pending=f.protocol.request('CORE_CRASH');f.timeout();
  assert.deepEqual(await pending,{requestId:firstId,status:'TIMED_OUT'});
  f.reply(7,completed());f.protocol.dispose();assert.equal(f.listeners.size,0);
});

test('cleanup result validator cannot describe incomplete cleanup as completed',()=>{
  assert.equal(validDesktopCleanupResult(completed()),true);
  assert.equal(validDesktopCleanupResult({...completed(),local:{...completed().local,microphoneReleased:false}}),false);
  assert.equal(validDesktopCleanupResult({...completed(),core:{...completed().core,execution:'UNKNOWN'}}),false);
  assert.equal(validDesktopCleanupResult({...completed(),status:'FAILED',failureReason:'EXECUTION_UNKNOWN',core:{...completed().core,execution:'UNKNOWN'}}),true);
});

function providerFixture(closeResult:{closed:boolean;pendingConfirmationCancelled:boolean;execution:'IDLE'|'UNKNOWN'}|Error){
  const observations:{microphones:(unknown|null)[];states:string[];transcripts:unknown[][];tools:number}={microphones:[],states:[],transcripts:[],tools:0};
  let trackState='live';let stops=0,sessionCloses=0,audioPauses=0,coreCloses=0;let release!:(value:{closed:boolean;pendingConfirmationCancelled:boolean;execution:'IDLE'|'UNKNOWN'})=>void;
  const coreGate=new Promise<{closed:boolean;pendingConfirmationCancelled:boolean;execution:'IDLE'|'UNKNOWN'}>((resolve,reject)=>{release=value=>closeResult instanceof Error?reject(closeResult):resolve(value);});
  const core={request:async(operation:string)=>{assert.equal(operation,'session.close');coreCloses++;return coreGate;}} as unknown as CoreTransport;
  const bridge=new VoiceToolBridge(()=>{},()=>{},undefined,undefined,undefined,core);
  const audio={pause:()=>{audioPauses++;},srcObject:{} as unknown,muted:false,paused:false,ended:false} as unknown as HTMLAudioElement;
  const provider=new OpenAIVoiceProvider({state:state=>observations.states.push(state),transcript:entries=>observations.transcripts.push(entries),microphone:stream=>observations.microphones.push(stream),tools:()=>{observations.tools++;}},audio,{core});
  const track={get readyState(){return trackState;},stop:()=>{stops++;trackState='ended';}};
  const internal=provider as unknown as {tools:VoiceToolBridge;session:{close():void};stream:{getTracks():typeof track[]}};
  internal.tools=bridge;internal.session={close:()=>{sessionCloses++;}};internal.stream={getTracks:()=>[track]};
  return {provider,observations,release:()=>release(closeResult instanceof Error?{closed:false,pendingConfirmationCancelled:false,execution:'UNKNOWN'}:closeResult),counts:()=>({stops,sessionCloses,audioPauses,coreCloses}),audio};
}

test('provider releases microphone, WebRTC and audio before awaiting authoritative Core cleanup',async()=>{
  const result={closed:true,pendingConfirmationCancelled:true,execution:'IDLE'} as const;const f=providerFixture(result);
  const pending=f.provider.prepareForBackground('HIDE');
  assert.deepEqual(f.counts(),{stops:1,sessionCloses:1,audioPauses:1,coreCloses:1});assert.equal(f.observations.microphones.at(-1),null);assert.equal(f.observations.states.at(-1),'disconnected');
  assert.deepEqual(f.observations.transcripts,[[]]);
  // A restore cannot reconnect while authoritative cleanup is pending.
  await f.provider.connect();assert.deepEqual(f.counts(),{stops:1,sessionCloses:1,audioPauses:1,coreCloses:1});
  f.release();assert.deepEqual(await pending,{status:'COMPLETED',local:{microphoneReleased:true,realtimeClosed:true,audioStopped:true},core:{state:'CLOSED',pendingConfirmationCancelled:true,execution:'IDLE'}});
});

test('background cleanup discards only conversational UI/session state, not persistent-memory authority',async()=>{
  const result={closed:true,pendingConfirmationCancelled:false,execution:'IDLE'} as const;const f=providerFixture(result);
  const internal=f.provider as unknown as {tools?:unknown;session?:unknown;stream?:unknown;memory?:unknown};
  const pending=f.provider.prepareForBackground('HIDE');assert.deepEqual(f.observations.transcripts,[[]]);assert.equal(internal.tools,undefined);assert.equal(internal.session,undefined);assert.equal(internal.stream,undefined);
  f.release();assert.equal((await pending).status,'COMPLETED');
});

test('unknown execution fails cleanup without retrying Core or the sensitive action',async()=>{
  const result={closed:true,pendingConfirmationCancelled:false,execution:'UNKNOWN'} as const;const f=providerFixture(result);
  const first=f.provider.prepareForBackground('QUIT');const duplicate=f.provider.prepareForBackground('QUIT');assert.equal(first,duplicate);
  f.release();assert.deepEqual(await first,{status:'FAILED',local:{microphoneReleased:true,realtimeClosed:true,audioStopped:true},core:{state:'CLOSED',pendingConfirmationCancelled:false,execution:'UNKNOWN'},failureReason:'EXECUTION_UNKNOWN'});
  assert.equal(f.counts().coreCloses,1);
});

test('Core cleanup failure is explicit after local media has still been released',async()=>{
  const f=providerFixture(new Error('private failure'));
  const pending=f.provider.prepareForBackground('CORE_CRASH');f.release();
  assert.deepEqual(await pending,{status:'FAILED',local:{microphoneReleased:true,realtimeClosed:true,audioStopped:true},core:{state:'FAILED',pendingConfirmationCancelled:false,execution:'UNKNOWN'},failureReason:'CORE_SESSION_CLOSE_FAILED'});
  assert.deepEqual(f.counts(),{stops:1,sessionCloses:1,audioPauses:1,coreCloses:1});
});

test('VoiceToolBridge close is awaitable, idempotent and cancels pending UI state once',async()=>{
  let calls=0;const core={request:async(operation:string)=>{assert.equal(operation,'session.close');calls++;return {closed:true,pendingConfirmationCancelled:true,execution:'IDLE'};}} as unknown as CoreTransport;
  const bridge=new VoiceToolBridge(()=>{},()=>{},undefined,undefined,undefined,core);
  const one=bridge.closeAndWait('PAGEHIDE');const two=bridge.closeAndWait('USER_DISCONNECT');
  assert.equal(one,two);assert.deepEqual(await one,{closed:true,pendingConfirmationCancelled:true,execution:'IDLE'});assert.equal(calls,1);
});
