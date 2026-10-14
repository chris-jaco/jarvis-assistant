import test from 'node:test';
import assert from 'node:assert/strict';
import { DesktopLifecycleRuntime } from '../desktop/lifecycle-runtime.js';
import type { DesktopCleanupOutcome, DesktopCleanupReason } from '../desktop/cleanup-protocol.js';

function deferred<T>(){
  let resolve!:(value:T)=>void;
  const promise=new Promise<T>(done=>{resolve=done;});
  return {promise,resolve};
}

function cleanupOutcome(reason:DesktopCleanupReason,status:'COMPLETED'|'FAILED'|'TIMED_OUT'):DesktopCleanupOutcome{
  const requestId='00000000-0000-4000-8000-000000000001';
  if(status==='TIMED_OUT')return {requestId,status};
  return {requestId,status,local:{microphoneReleased:true,realtimeClosed:true,audioStopped:true},core:{state:status==='COMPLETED'?'CLOSED':'FAILED',pendingConfirmationCancelled:true,execution:'IDLE'},...(status==='FAILED'?{failureReason:'CORE_SESSION_CLOSE_FAILED' as const}:{})};
}

function fixture(){
  const requests:DesktopCleanupReason[]=[];const gates:Array<ReturnType<typeof deferred<DesktopCleanupOutcome>>>=[];let active:Promise<DesktopCleanupOutcome>|undefined;
  const events:string[]=[];let stops=0,quits=0,disposals=0,aborts=0;
  const runtime=new DesktopLifecycleRuntime({
    cleanup:{
      request:reason=>{requests.push(reason);if(active)return active;const gate=deferred<DesktopCleanupOutcome>();gates.push(gate);active=gate.promise.finally(()=>{active=undefined;});return active;},
      dispose:()=>{disposals++;events.push('cleanup.dispose');}
    },
    ipc:{abortPending:()=>{aborts++;events.push('ipc.abort');},dispose:()=>{disposals++;events.push('ipc.dispose');}},
    hideWindow:()=>events.push('window.hide'),restoreWindow:()=>events.push('window.restore'),destroyWindow:()=>events.push('window.destroy'),
    stopCore:async()=>{stops++;events.push('core.stop');},showHideFailure:async()=>{events.push('dialog.hide-failed');},showCoreCrash:async()=>{events.push('dialog.core-crash');},
    quitApplication:()=>{quits++;events.push('app.quit');}
  });
  runtime.ready();
  return {runtime,requests,gates,events,counts:()=>({stops,quits,disposals,aborts})};
}

async function tick():Promise<void>{await Promise.resolve();await Promise.resolve();}

test('X cleanup COMPLETED hides exactly once and leaves Core resident',async()=>{
  const f=fixture();const one=f.runtime.hide();const two=f.runtime.hide();assert.equal(one,two);await tick();
  assert.deepEqual(f.requests,['HIDE']);assert.deepEqual(f.events,['ipc.abort']);
  f.gates[0]!.resolve(cleanupOutcome('HIDE','COMPLETED'));assert.equal(await one,'COMPLETED');
  assert.equal(f.runtime.state,'HIDDEN_DISCONNECTED');assert.deepEqual(f.events,['ipc.abort','window.hide']);assert.deepEqual(f.counts(),{stops:0,quits:0,disposals:0,aborts:1});
});

for(const status of ['FAILED','TIMED_OUT'] as const)test(`X cleanup ${status} keeps the window visible and reports a safe error`,async()=>{
  const f=fixture();const hiding=f.runtime.hide();await tick();f.gates[0]!.resolve(cleanupOutcome('HIDE',status));assert.equal(await hiding,status);
  assert.equal(f.runtime.state,'VISIBLE_ERROR');assert.deepEqual(f.events,['ipc.abort','window.restore','dialog.hide-failed']);assert.equal(f.events.includes('window.hide'),false);
});

test('second instance restores the same hidden window without starting Core or reconnecting voice',async()=>{
  const f=fixture();const hiding=f.runtime.hide();await tick();f.gates[0]!.resolve(cleanupOutcome('HIDE','COMPLETED'));await hiding;
  assert.equal(f.runtime.restore(),true);assert.equal(f.runtime.state,'VISIBLE_DISCONNECTED');assert.deepEqual(f.events,['ipc.abort','window.hide','window.restore']);assert.equal(f.counts().stops,0);
});

test('restore during cleanup supersedes stale hide and cannot hide afterward',async()=>{
  const f=fixture();const hiding=f.runtime.hide();await tick();assert.equal(f.runtime.restore(),true);assert.equal(f.runtime.state,'VISIBLE_DISCONNECTED');
  f.gates[0]!.resolve(cleanupOutcome('HIDE','COMPLETED'));await hiding;
  assert.deepEqual(f.events,['ipc.abort','window.restore']);assert.equal(f.events.includes('window.hide'),false);
});

test('explicit quit performs one bounded cleanup, disposes IPC, stops Core and exits',async()=>{
  const f=fixture();const first=f.runtime.quit();const second=f.runtime.quit();assert.equal(first,second);await tick();assert.deepEqual(f.requests,['QUIT']);
  f.gates[0]!.resolve(cleanupOutcome('QUIT','COMPLETED'));await first;
  assert.equal(f.runtime.state,'TERMINATED');assert.deepEqual(f.events,['ipc.abort','cleanup.dispose','ipc.dispose','core.stop','window.destroy','app.quit']);assert.deepEqual(f.counts(),{stops:1,quits:1,disposals:2,aborts:1});
});

test('quit during hide has priority and stale hide cannot hide or duplicate terminal effects',async()=>{
  const f=fixture();const hiding=f.runtime.hide();await tick();const quitting=f.runtime.quit();await tick();
  assert.deepEqual(f.requests,['HIDE','QUIT']);f.gates[0]!.resolve(cleanupOutcome('HIDE','COMPLETED'));await Promise.all([hiding,quitting]);
  assert.equal(f.events.includes('window.hide'),false);assert.equal(f.counts().stops,1);assert.equal(f.counts().quits,1);assert.equal(f.runtime.state,'TERMINATED');
});

test('Core crash while hidden restores for the dialog, never restarts Core and shuts down once',async()=>{
  const f=fixture();const hiding=f.runtime.hide();await tick();f.gates[0]!.resolve(cleanupOutcome('HIDE','COMPLETED'));await hiding;
  const crashing=f.runtime.coreCrash();await tick();assert.deepEqual(f.requests,['HIDE','CORE_CRASH']);f.gates[1]!.resolve(cleanupOutcome('CORE_CRASH','FAILED'));await crashing;
  assert.deepEqual(f.events.slice(-5),['core.stop','window.restore','dialog.core-crash','window.destroy','app.quit']);assert.deepEqual(f.counts(),{stops:1,quits:1,disposals:2,aborts:2});
});

test('Core crash during hide supersedes it and late cleanup cannot hide or retry',async()=>{
  const f=fixture();const hiding=f.runtime.hide();await tick();const crashing=f.runtime.coreCrash();await tick();f.gates[0]!.resolve(cleanupOutcome('HIDE','TIMED_OUT'));await Promise.all([hiding,crashing]);
  assert.equal(f.events.includes('window.hide'),false);assert.equal(f.events.includes('dialog.hide-failed'),false);assert.equal(f.events.filter(value=>value==='core.stop').length,1);assert.equal(f.events.filter(value=>value==='app.quit').length,1);
});

test('UNKNOWN cleanup cannot hide and is never retried',async()=>{
  const f=fixture();const hiding=f.runtime.hide();await tick();
  f.gates[0]!.resolve({requestId:'00000000-0000-4000-8000-000000000001',status:'FAILED',local:{microphoneReleased:true,realtimeClosed:true,audioStopped:true},core:{state:'CLOSED',pendingConfirmationCancelled:false,execution:'UNKNOWN'},failureReason:'EXECUTION_UNKNOWN'});
  assert.equal(await hiding,'FAILED');assert.deepEqual(f.requests,['HIDE']);assert.equal(f.events.includes('window.hide'),false);
});
