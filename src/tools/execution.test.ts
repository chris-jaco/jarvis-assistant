import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { ToolRegistry } from './registry.js';
import { ToolExecutor } from './execution.js';

test('tool latency separates preparation, confirmation wait and execution without changing approval', async () => {
  let now = 1000; const registry = new ToolRegistry();
  registry.register({ id: 'test.timing', name: 'Timing', description: 'Timing', integration: 'test', capability: 'write', permission: 'WRITE', confirm: true, schema: z.object({}), prepare: async () => { now += 3000; return {}; }, execute: async () => { now += 4000; return {}; } });
  const executor = new ToolExecutor(registry, () => now);
  try {
    const p = await executor.invoke('timing', 'test.timing', {}); if (p.status !== 'pending') throw new Error();
    now += 30_000; assert.equal((await executor.decide(p.confirmationId, true)).status, 'success');
    const row = executor.telemetry.snapshot()[0]!;
    assert.equal(row.durationMs, 37_000); assert.equal(row.preparationMs, 3000); assert.equal(row.confirmationWaitMs, 30_000); assert.equal(row.executionMs, 4000);
  } finally { executor.close(); }
});

test('editable content review freezes the approved edit and deterministically creates a separate write confirmation', async () => {
  const registry=new ToolRegistry();const executed:string[]=[];let contentDecision:string|undefined;
  registry.register({id:'test.prepare',name:'Prepare',description:'Prepare',integration:'test',capability:'prepare',permission:'WRITE',confirm:false,confirmWhen:()=>true,schema:z.object({candidate:z.string()}),prepare:async input=>input,confirmationView:input=>({kind:'EDITABLE_CONTENT',content:(input as {candidate:string}).candidate,label:'Exact content',maxLength:20}),confirmationLifecycle:{pending:()=>{},decided:(_input,_id,approved,decision)=>{if(approved)contentDecision=decision?.editedContent;},invalidated:()=>{}},execute:async()=>({intentId:'internal'}),followup:()=>({toolId:'test.write',input:{intentId:'internal'}})});
  registry.register({id:'test.write',name:'Write',description:'Write',integration:'test',capability:'write',permission:'WRITE',confirm:true,schema:z.object({intentId:z.literal('internal')}),execute:async()=>{executed.push(contentDecision!);return {written:true};}});
  const executor=new ToolExecutor(registry);try{
    const review=await executor.invoke('review','test.prepare',{candidate:'voice candidate'});assert.equal(review.status,'pending');if(review.status!=='pending')throw new Error();assert.equal(review.review?.content,'voice candidate');assert.equal(executed.length,0);
    const write=await executor.decide(review.confirmationId,true,{editedContent:'visually corrected'});assert.equal(write.status,'pending');if(write.status!=='pending')throw new Error();assert.equal(contentDecision,'visually corrected');assert.equal(executed.length,0);
    const result=await executor.decide(write.confirmationId,true);assert.equal(result.status,'success');assert.deepEqual(executed,['visually corrected']);assert.equal((await executor.decide(write.confirmationId,true)).status,'error');assert.deepEqual(executed,['visually corrected']);
  }finally{executor.close();}
});

test('editable review rejects missing content and never starts its followup',async()=>{
  const registry=new ToolRegistry();let invalidated=0,executed=0;
  registry.register({id:'test.review',name:'Review',description:'Review',integration:'test',capability:'review',permission:'WRITE',confirm:false,confirmWhen:()=>true,schema:z.object({}),prepare:async()=>({}),confirmationView:()=>({kind:'EDITABLE_CONTENT',content:'candidate',label:'Content',maxLength:10}),confirmationLifecycle:{pending:()=>{},decided:()=>{},invalidated:()=>{invalidated++;}},execute:async()=>{executed++;return {};},followup:()=>({toolId:'missing',input:{}})});
  const executor=new ToolExecutor(registry);try{const pending=await executor.invoke('review','test.review',{});assert.equal(pending.status,'pending');if(pending.status!=='pending')throw new Error();const result=await executor.decide(pending.confirmationId,true);assert.equal(result.status,'error');assert.equal(invalidated,1);assert.equal(executed,0);assert.equal(executor.pendingState(),null);}finally{executor.close();}
});
