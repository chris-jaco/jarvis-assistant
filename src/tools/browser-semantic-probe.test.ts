import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { JSDOM } from 'jsdom';
import { conversationFixture } from './fixtures/semantic-conversation.js';
const script=await readFile('scripts/browser-semantic-probe.js','utf8');
function probe(html:string) {
 const dom=new JSDOM(html,{url:'https://private.example/private?secret=PRIVATE_URL',pretendToBeVisual:true}),win=dom.window;
 const fail=()=>{throw new Error('Forbidden read/write');};
 win.HTMLElement.prototype.checkVisibility=function(){return !this.closest('[hidden],[aria-hidden="true"],[inert]');};
 win.HTMLElement.prototype.getBoundingClientRect=()=>({width:10,height:10} as DOMRect);
 for(const property of ['textContent','innerText'])Object.defineProperty(win.HTMLElement.prototype,property,{get:fail,set:fail,configurable:true});
 for(const prototype of [win.HTMLInputElement.prototype,win.HTMLTextAreaElement.prototype])Object.defineProperty(prototype,'value',{get:fail,set:fail,configurable:true});
 for(const method of ['click','focus','dispatchEvent','setAttribute','removeAttribute','appendChild','remove','replaceWith'] as const)(win.HTMLElement.prototype as any)[method]=fail;
 for(const property of ['cookie'])Object.defineProperty(win.document,property,{get:fail,configurable:true});
 win.document.write=fail;win.document.execCommand=fail;
 let output='';const before=win.document.documentElement.outerHTML;
 const readDocument=new Proxy({querySelectorAll:win.document.querySelectorAll.bind(win.document),getElementById:win.document.getElementById.bind(win.document),readyState:win.document.readyState},{get:(target,key)=>key in target?Reflect.get(target,key):fail(),set:fail});
 try{runInNewContext(script,{document:readDocument,console:{log:(value:string)=>{output=value;}},fetch:fail,chrome:new Proxy({},{get:fail}),localStorage:new Proxy({},{get:fail}),sessionStorage:new Proxy({},{get:fail})},{timeout:1000});assert.equal(win.document.documentElement.outerHTML,before);return {output,report:JSON.parse(output)};}finally{win.close();}
}
test('manual probe reads only structural evidence and cannot click/write/read messages or secrets',()=>{const {output,report}=probe(conversationFixture({name:'PRIVATE_NAME',identity:'PRIVATE_EMAIL@example.test',injection:true}));assert.equal(report.readOnly,true);assert.equal(report.visibleLogs,1);assert.equal(report.relationships[0].associatedComposers,1);assert.equal(report.relationships[0].associatedSendControls,1);assert.equal(report.identityValuesInspected,false);for(const marker of ['PRIVATE_NAME','PRIVATE_EMAIL','SECRET_MESSAGE_SENTINEL','PRIVATE_URL','Ignore safety'])assert.ok(!output.includes(marker));});
test('missing evidence remains structural absence, not a false incompatibility verdict',()=>{const {report}=probe('<div contenteditable="true" role="textbox"></div><button aria-label="Custom private action">PRIVATE_MESSAGE</button>');assert.equal(report.visibleLogs,0);assert.equal(report.visibleComposerCandidates,1);assert.equal(report.relationships.length,0);assert.equal(report.activeConversationVerified,false);assert.equal(report.documentEpochVerified,false);assert.equal(report.nodeStabilityVerified,false);});
test('probe refuses hidden/deceptive recipient labels and bounds output',()=>{const {report}=probe(Array.from({length:25},(_,n)=>conversationFixture({id:`chat-${n}`})).join('').replaceAll('itemprop="email"','hidden itemprop="email"'));assert.equal(report.truncated,true);assert.equal(report.visibleLogs,20);assert.equal(report.relationships.length,8);assert.equal(report.relationships[0].visibleEmailMarkers,0);assert.ok(JSON.stringify(report).length<5000);});
