import test from 'node:test';
import assert from 'node:assert/strict';
import type { MenuItemConstructorOptions } from 'electron';
import { desktopApplicationMenu, registerDesktopWindowControls, requestSafeDesktopHide, windowsLocalQuit, type DesktopKeyboardInput } from '../desktop/window-controls.js';

const input=(overrides:Partial<DesktopKeyboardInput>={}):DesktopKeyboardInput=>({type:'keyDown',key:'q',control:true,alt:false,shift:false,meta:false,isAutoRepeat:false,...overrides});

function fixture(){
  const windowListeners=new Map<string,Function>();const webListeners=new Map<string,Function>();let hides=0,quits=0;
  const target={on:(event:string,listener:Function)=>windowListeners.set(event,listener),removeListener:(event:string)=>windowListeners.delete(event),webContents:{on:(event:string,listener:Function)=>webListeners.set(event,listener),removeListener:(event:string)=>webListeners.delete(event)}};
  const dispose=registerDesktopWindowControls(target as never,{hide:()=>{hides++;},quit:()=>{quits++;}},'win32');
  return {windowListeners,webListeners,dispose,counts:()=>({hides,quits})};
}

test('minimize keeps Electron defaults and never starts voice cleanup',()=>{
  const f=fixture();assert.equal(f.windowListeners.has('minimize'),false);assert.equal(f.webListeners.has('minimize'),false);assert.deepEqual(f.counts(),{hides:0,quits:0});f.dispose();
});

test('window close is prevented and routed exactly once to lifecycle hide',()=>{
  const f=fixture();let prevented=0;f.windowListeners.get('close')!({preventDefault:()=>{prevented++;}});
  assert.equal(prevented,1);assert.deepEqual(f.counts(),{hides:1,quits:0});f.dispose();assert.equal(f.windowListeners.size,0);assert.equal(f.webListeners.size,0);
});

test('Windows Ctrl+Q is handled locally and cannot be swallowed by the renderer',()=>{
  const f=fixture();let prevented=0;const listener=f.webListeners.get('before-input-event')!;
  listener({preventDefault:()=>{prevented++;}},input());
  listener({preventDefault:()=>{prevented++;}},input({isAutoRepeat:true}));
  listener({preventDefault:()=>{prevented++;}},input({control:false}));
  assert.equal(prevented,1);assert.deepEqual(f.counts(),{hides:0,quits:1});f.dispose();
});

test('local quit recognizer is Windows-specific at registration and rejects modified shortcuts',()=>{
  assert.equal(windowsLocalQuit(input()),true);assert.equal(windowsLocalQuit(input({alt:true})),false);assert.equal(windowsLocalQuit(input({meta:true})),false);assert.equal(windowsLocalQuit(input({key:'w'})),false);
  const f=fixture();f.dispose();let quits=0;const listeners=new Map<string,Function>();const target={on:()=>{},removeListener:()=>{},webContents:{on:(event:string,listener:Function)=>listeners.set(event,listener),removeListener:()=>{}}};
  registerDesktopWindowControls(target as never,{hide:()=>{},quit:()=>{quits++;}},'linux');listeners.get('before-input-event')!({preventDefault:()=>{}},input());assert.equal(quits,0);
});

test('visible application menu exposes Salir de Atlas and invokes the same quit authority',()=>{
  let quits=0;const template=desktopApplicationMenu({hide:()=>{},quit:()=>{quits++;}});const submenu=template[0]!.submenu as MenuItemConstructorOptions[];const quit=submenu[0]!;
  assert.equal(quit.label,'Salir de Atlas');assert.equal(quit.accelerator,'CommandOrControl+Q');(quit.click as Function)();assert.equal(quits,1);
});

test('packaged menu exposes a local credential reconfiguration action',()=>{
  let reconfigures=0;const template=desktopApplicationMenu({hide:()=>{},quit:()=>{},reconfigureCredentials:()=>{reconfigures++;}});
  const submenu=template[0]!.submenu as MenuItemConstructorOptions[];
  assert.equal(submenu[0]!.label,'Reconfigurar API key…');submenu[0]!.click?.(undefined as never,undefined as never,undefined as never);assert.equal(reconfigures,1);
});

test('Tray availability gates hide fail-visible without allowing native close',()=>{
  let hides=0,warnings=0;
  assert.equal(requestSafeDesktopHide({canHideSafely:()=>false,hide:()=>{hides++;},unavailable:()=>{warnings++;}}),true);
  assert.deepEqual({hides,warnings},{hides:0,warnings:1});
  const result={status:'pending'};
  assert.equal(requestSafeDesktopHide({canHideSafely:()=>true,hide:()=>{hides++;return result;},unavailable:()=>{warnings++;}}),result);
  assert.deepEqual({hides,warnings},{hides:1,warnings:1});
});
