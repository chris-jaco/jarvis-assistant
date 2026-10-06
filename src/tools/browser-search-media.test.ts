import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { ContentEngine } from '../../extension/src/content-engine.js';
import { resolveSearch } from '../../extension/src/search-controls.js';
import { MediaState } from '../../extension/src/media-state.js';
import { pollMedia } from '../browser/media-poll.js';
import type { BrowserObservation, MediaSummary } from '../browser/provider.js';
import { observationSchema, replySchema } from '../browser/attached/protocol.js';

function fixture(html: string) {
  const dom = new JSDOM(html, { url: 'https://fixture.example/', pretendToBeVisual: true }); const win = dom.window;
  win.HTMLElement.prototype.checkVisibility = function() { return !this.closest('[hidden]'); };
  win.HTMLElement.prototype.getBoundingClientRect = function() { const n = [...win.document.querySelectorAll('*')].indexOf(this); return { x:n*8, y:0, left:n*8, right:n*8+6, top:0, bottom:6, width:6, height:6, toJSON() {} }; };
  win.document.elementFromPoint = x => [...win.document.querySelectorAll('*')].find(el => { const r = el.getBoundingClientRect(); return x >= r.left && x <= r.right; }) ?? null;
  const engine = new ContentEngine(win as unknown as Window & typeof globalThis);
  const access = { scopeId: randomUUID(), tabId: randomUUID(), session: randomUUID(), epoch: randomUUID(), origin: win.location.origin, expiresAt: Date.now()+900_000 };
  engine.initialize(access);
  const observe = async () => { const result = await engine.run('observe', { scopeId: access.scopeId, tabId: access.tabId }, Date.now()+15000, access); assert.equal(result.outcome,'OK'); return (result as any).data; };
  const act = (op: 'type'|'press'|'click'|'media', data: any, element: any, extra = {}) => engine.run(op, { scopeId: access.scopeId, tabId: access.tabId, documentId: data.documentId, snapshotId: data.snapshotId, ref: element.ref, ...extra }, Date.now()+15000, access);
  return { dom, win, engine, observe, act, close() { engine.destroy(); win.close(); } };
}
test('GET search uses real HTML form associations including external submitters and rejects POST overrides', async () => {
  const f = fixture('<form id="find" method="get" action="/results"><input name="q" type="text" role="combobox" aria-label="Search"></form><button form="find" type="submit">Search</button>');
  try {
    let submits = 0; f.win.document.querySelector('form')!.addEventListener('submit', e => { e.preventDefault(); submits++; });
    let data = await f.observe(); const input = data.elements.find((e: any) => e.functionalKind==='SEARCH_INPUT');
    assert.deepEqual(input.capabilities,['TYPE_SEARCH','SUBMIT_SEARCH']); assert.equal(input.role,'combobox');
    assert.equal((await f.act('type',data,input,{text:'fixture',mode:'replace'})).outcome,'OK');
    data = await f.observe(); const button = data.elements.find((e:any) => e.functionalKind==='SEARCH_SUBMIT');
    assert.equal((await f.act('click',data,button)).outcome,'OK'); assert.equal(submits,1);
    f.win.document.querySelector('button')!.setAttribute('formmethod','post'); data = await f.observe();
    const blocked = data.elements.find((e:any) => e.role==='button'); assert.equal(blocked.action,'blocked');
    assert.equal((await f.act('click',data,blocked)).outcome,'ERROR'); assert.equal(submits,1);
  } finally { f.close(); }
});
test('generic SPA searchbox/combobox supports Enter and associated external Search button exactly once', async () => {
  for (const role of ['searchbox','combobox']) {
    const f = fixture(`<div role="search"><input id="q" type="text" role="${role}" aria-label="Search"></div><button aria-controls="q">Search</button>`);
    try {
      let entered=0,clicked=0; f.win.document.querySelector('input')!.addEventListener('keydown', e => { if(e.key==='Enter') entered++; });
      f.win.document.querySelector('button')!.addEventListener('click',()=>clicked++);
      let data=await f.observe(); let input=data.elements.find((e:any)=>e.functionalKind==='SEARCH_INPUT');
      assert.equal((await f.act('type',data,input,{text:'music',mode:'replace'})).outcome,'OK');
      assert.equal((await f.act('press',data,input,{key:'Enter'}) as any).conflict.reason,'SNAPSHOT_CONSUMED');
      data=await f.observe(); input=data.elements.find((e:any)=>e.functionalKind==='SEARCH_INPUT');
      assert.equal((await f.act('press',data,input,{key:'Enter'})).outcome,'OK'); assert.equal(entered,1);
      data=await f.observe(); const button=data.elements.find((e:any)=>e.functionalKind==='SEARCH_SUBMIT');
      assert.equal((await f.act('click',data,button)).outcome,'OK'); assert.equal(clicked,1);
    } finally { f.close(); }
  }
});
test('chat/composer, ambiguous search and POST forms never acquire submission capability', async () => {
  for (const html of [
    '<form method="post"><input type="search" aria-label="Search"><button>Search</button></form>',
    '<div role="search" aria-label="Chat composer"><input type="text" aria-label="Search"><button>Search</button></div>',
    '<form method="get"><input type="search"><textarea aria-label="Message"></textarea><button>Search</button></form>',
    '<div role="search"><input type="search"><input type="search"><button>Search</button></div>',
    '<div contenteditable="true" role="textbox" aria-label="Search"></div>',
    '<input type="text" role="combobox" aria-label="Recipient"><button>Search</button>'
  ]) {
    const f=fixture(html); try { const data=await f.observe(); assert.ok(!data.elements.some((e:any)=>e.capabilities.includes('SUBMIT_SEARCH'))); } finally { f.close(); }
  }
});
test('changing associated search input invalidates a button without remapping it', async () => {
  const f=fixture('<div role="search"><input id="q" type="search"><button>Search</button></div>');
  try { const data=await f.observe(); const button=data.elements.find((e:any)=>e.functionalKind==='SEARCH_SUBMIT'); f.win.document.querySelector('input')!.outerHTML='<input id="q" type="search">'; assert.equal((await f.act('click',data,button) as any).conflict.reason,'ELEMENT_CHANGED'); } finally { f.close(); }
});
test('search results are prioritized over a long header without growing observation or exposing input values', async () => {
  const f=fixture(Array.from({length:80},(_,n)=>`<a href="/nav/${n}">Nav</a>`).join('')+'<main><input type="search" value="PRIVATE_SEARCH"><a href="/watch">Result song</a></main>');
  try {
    const data=await f.observe(); assert.ok(data.elements.some((e:any)=>e.name==='Result song' && e.capabilities.includes('OPEN_LINK')));
    assert.ok(data.elements.length<=40); assert.ok(JSON.stringify(data).length<=12000); assert.ok(!JSON.stringify(data).includes('PRIVATE_SEARCH'));
    assert.equal(observationSchema.safeParse(data).success,true);
  } finally { f.close(); }
});
function setMedia(el: HTMLMediaElement, props: Record<string,unknown>) { for(const [key,value] of Object.entries(props)) Object.defineProperty(el,key,{configurable:true,value}); }
test('media states distinguish loading, paused, ended, buffering, error, unknown and advancing playback', async () => {
  const f=fixture('<figure><video></video></figure>');
  try {
    const media=f.win.document.querySelector('video')!; const state=new MediaState(f.win as unknown as Window & typeof globalThis);
    for(const [props,expected] of [
      [{readyState:0,paused:true,ended:false,error:null},'LOADING'],
      [{readyState:4,paused:true,ended:false,error:null},'PAUSED'],
      [{readyState:4,paused:true,ended:true,error:null},'ENDED'],
      [{readyState:1,paused:false,ended:false,error:null},'BUFFERING'],
      [{readyState:4,paused:false,ended:false,error:{code:3}},'ERROR'],
      [{readyState:4,paused:false,ended:false,error:null,currentTime:0},'UNKNOWN']
    ] as const) { setMedia(media,props); assert.equal((await state.read(f.win.document,Date.now()+5000)).playback,expected); }
    let progress=0; Object.defineProperty(media,'currentTime',{configurable:true,get:()=>progress});
    const timer=setInterval(()=>progress+=0.1,30); try { assert.equal((await state.read(f.win.document,Date.now()+5000)).playback,'PLAYING'); } finally { clearInterval(timer); }
  } finally { f.close(); }
});
test('autoplay handoff only follows real NotAllowedError; Play/Pause controls are explicit and not form submits', async () => {
  const f=fixture('<figure><video></video><button>Play</button><button>Pause</button></figure><form method="post"><video></video><button>Play</button></form>');
  try {
    const media=f.win.document.querySelector('video')!;
    media.play=async()=>{ throw new f.win.DOMException('Blocked','NotAllowedError'); };
    let data=await f.observe(); const video=data.elements.find((e:any)=>e.functionalKind==='MEDIA_ELEMENT');
    assert.equal((await f.act('media',data,video,{action:'play'}) as any).reason,'MEDIA_USER_GESTURE');
    media.play=async()=>{ throw new f.win.DOMException('Bad media','NotSupportedError'); }; data=await f.observe();
    assert.equal((await f.act('media',data,data.elements.find((e:any)=>e.functionalKind==='MEDIA_ELEMENT'),{action:'play'})).outcome,'ERROR');
    media.play=async()=>{ throw new Error('Failure after possible side effect'); }; data=await f.observe();
    assert.equal((await f.act('media',data,data.elements.find((e:any)=>e.functionalKind==='MEDIA_ELEMENT'),{action:'play'}) as any).code,'EXECUTION_UNKNOWN');
    assert.equal(data.elements.filter((e:any)=>e.functionalKind==='MEDIA_PLAY').length,1);
    assert.equal(data.elements.filter((e:any)=>e.functionalKind==='MEDIA_PAUSE').length,1);
  } finally { f.close(); }
});
test('ad evidence is contextual, skips only explicit enabled controls, and never manipulates non-skippable ads', async () => {
  const f=fixture('<figure><video></video><span role="status">Advertisement</span><button id="skip">Skip ad</button></figure><button>Skip ad</button>');
  try {
    const media=f.win.document.querySelector('video')!; setMedia(media,{readyState:4,paused:true,ended:false});
    let data=await f.observe(); assert.equal(data.media.advertisement,'DETECTED'); assert.equal(data.media.skipAvailable,true);
    assert.equal(data.elements.filter((e:any)=>e.functionalKind==='AD_SKIP').length,1);
    let clicks=0; f.win.document.querySelector('#skip')!.addEventListener('click',()=>{clicks++; f.win.document.querySelector('span')!.remove(); f.win.document.querySelector('#skip')!.remove(); });
    assert.equal((await f.act('click',data,data.elements.find((e:any)=>e.functionalKind==='AD_SKIP'))).outcome,'OK'); assert.equal(clicks,1);
    data=await f.observe(); assert.equal(data.media.advertisement,'UNKNOWN'); assert.equal(data.media.skipAvailable,false);
    f.win.document.querySelector('figure')!.insertAdjacentHTML('beforeend','<span role="status">Anuncio</span><button disabled>Omitir anuncio</button>');
    data=await f.observe(); assert.equal(data.media.advertisement,'DETECTED'); assert.equal(data.media.skipAvailable,false);
    assert.equal(data.elements.filter((e:any)=>e.functionalKind==='AD_SKIP').length,0);
  } finally { f.close(); }
});
const summary=(ad:MediaSummary['advertisement'],skip=false):MediaSummary=>({presence:'AVAILABLE',playback:'PLAYING',advertisement:ad,skipAvailable:skip});
const observed=(ad:MediaSummary['advertisement'],skip=false):BrowserObservation=>({tabId:randomUUID(),title:'',url:'',truncated:false,media:summary(ad,skip),elements:skip?[{ref:randomUUID(),role:'button',name:'Skip ad',type:'',disabled:false,action:'media',functionalKind:'AD_SKIP',capabilities:['SKIP_AD']}]:[]});
test('ad polling runs three bounded READs without writes/narration when no skip appears', async () => {
  let clock=0,reads=0,skips=0; const waits:number[]=[];
  const result=await pollMedia({observe:async()=>{reads++;return observed('DETECTED');},skip:async()=>{skips++;throw new Error();}},new AbortController().signal,{now:()=>clock,sleep:async ms=>{waits.push(ms);clock+=ms;}});
  assert.equal(reads,3); assert.equal(skips,0); assert.deepEqual(waits,[3000,3000]); assert.equal(result.waitEnded,'BUDGET_EXHAUSTED');
});
test('polling detects skip, invokes it once and preserves COMPLETED when auto-observe failed', async () => {
  let clock=0,reads=0,skips=0;
  const result=await pollMedia({observe:async()=>observed('DETECTED',++reads===2),skip:async()=>{skips++;return {action:{status:'COMPLETED'},result:{interacted:true},observation:{status:'FAILED',reason:'CONTENT_UNAVAILABLE'},requiresFreshObservation:true};}},new AbortController().signal,{now:()=>clock,sleep:async ms=>{clock+=ms;}});
  assert.equal(reads,2);assert.equal(skips,1);assert.equal(result.skip?.action.status,'COMPLETED');assert.equal(result.skip?.observation.status,'FAILED');
});
test('uncertain skip never retries and ad ending returns immediately without any write', async () => {
  let reads=0,skips=0;
  await assert.rejects(pollMedia({observe:async()=>observed('DETECTED',true),skip:async()=>{skips++;throw new Error('EXECUTION_UNKNOWN');}},new AbortController().signal),/EXECUTION_UNKNOWN/);assert.equal(skips,1);
  const result=await pollMedia({observe:async()=>observed(++reads===1?'DETECTED':'UNKNOWN'),skip:async()=>{throw new Error();}},new AbortController().signal,{sleep:async()=>{}});
  assert.equal(reads,2);assert.equal(result.observation?.media?.playback,'PLAYING');
});
test('poll deadline prevents another READ and external cancellation never executes skip', async () => {
  let clock=0,reads=0,skips=0;
  const result=await pollMedia({observe:async()=>{reads++;return observed('DETECTED');},skip:async()=>{skips++;throw new Error();}},new AbortController().signal,{now:()=>clock,sleep:async()=>{clock=10_001;}});
  assert.equal(reads,1);assert.equal(skips,0);assert.equal(result.waitEnded,'BUDGET_EXHAUSTED');
  const controller=new AbortController();
  await assert.rejects(pollMedia({observe:async()=>{controller.abort();return observed('DETECTED',true);},skip:async()=>{skips++;throw new Error();}},controller.signal));assert.equal(skips,0);
});
test('modal observation does not pull player controls from outside its scope', async () => {
  const f=fixture('<figure><video></video><button>Skip ad</button><div role="dialog" aria-label="Choices"><button>Reject all</button></div></figure>');
  try { const data=await f.observe();assert.equal(data.media.presence,'NONE');assert.ok(!data.elements.some((e:any)=>e.functionalKind==='AD_SKIP')); } finally { f.close(); }
});
test('protocol remains bounded/strict and extension permissions remain exactly the accepted three', async () => {
  const manifest=JSON.parse(await readFile('extension/manifest.json','utf8'));assert.deepEqual(manifest.permissions,['activeTab','scripting','nativeMessaging']);
  assert.equal(replySchema.safeParse({outcome:'OK',data:{completed:true,javascript:'evil'}}).success,false);
  assert.equal(resolveSearch(fixtureInput('<form method="post"><input type="search"></form>')),undefined);
});
function fixtureInput(html:string):HTMLInputElement { const dom=new JSDOM(html,{url:'https://fixture.example/'}); const input=dom.window.document.querySelector('input')!; dom.window.close(); return input; }
