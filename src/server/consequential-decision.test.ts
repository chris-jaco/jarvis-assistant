import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { z } from 'zod';
import { createToolsHandler } from './tools.js';
import { ToolRegistry } from '../tools/registry.js';
import type { BrowserAdapter } from '../tools/adapters/browser.js';
test('decision restores the exact browser session context of preparation, including concurrent sessions',async()=>{
 const scope=new AsyncLocalStorage<string>();const prepared:string[]=[];const executed:string[]=[];const registry=new ToolRegistry();
 registry.register({id:'fixture.consequential',name:'Fixture',description:'Test simulation',integration:'browser',capability:'simulation',permission:'SENSITIVE',schema:z.object({}).strict(),prepare:async()=>{assert.ok(scope.getStore());prepared.push(scope.getStore()!);return {session:scope.getStore()};},summarize:()=> 'Simulated action',execute:async raw=>{assert.equal(scope.getStore(),(raw as {session:string}).session);executed.push(scope.getStore()!);return {simulationOnly:true};}});
 const browser={inSession:<T>(id:string,work:()=>Promise<T>)=>scope.run(id,work),state:()=>undefined,endSession:async()=>{},close:async()=>{},diagnostics:undefined,presentationEnabled:false} as unknown as BrowserAdapter;
 const runtime=createToolsHandler({}, {}, {runtime:{registry,timezone:'Europe/Madrid',browser}});const server=createServer(async(req,res)=>{if(!await runtime.handle(req,res)){res.writeHead(404);res.end();}});await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const url=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
 const post=async(path:string,body:unknown,cookie?:string)=>{const response=await fetch(url+path,{method:'POST',headers:{'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},body:JSON.stringify(body)});return {response,data:await response.json() as any};};
 try{const cookies:string[]=[];const pending:string[]=[];for(let i=0;i<2;i++){const session=await post('/api/tools/session',{});const cookie=session.response.headers.get('set-cookie')!.split(';')[0]!;cookies.push(cookie);const action=await post('/api/tools/invoke',{invocationId:'call',toolId:'fixture.consequential',input:{}},cookie);assert.equal(action.data.status,'pending');pending.push(action.data.confirmationId);}
 const foreign=await post('/api/tools/decision',{confirmationId:pending[0],approved:true},cookies[1]);assert.equal(foreign.data.category,'EXPIRED');const results=await Promise.all(pending.map((confirmationId,i)=>post('/api/tools/decision',{confirmationId,approved:true},cookies[i])));assert.ok(results.every(r=>r.data.status==='success'));assert.equal(new Set(executed).size,2);assert.deepEqual([...executed].sort(),[...prepared].sort());
 }finally{runtime.close();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
