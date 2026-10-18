import type { MenuItemConstructorOptions } from 'electron';

export interface DesktopKeyboardInput {
  type:string;
  key:string;
  control:boolean;
  alt:boolean;
  shift:boolean;
  meta:boolean;
  isAutoRepeat:boolean;
}

export interface DesktopWindowControlsTarget {
  on(event:'close',listener:(event:{preventDefault():void})=>void):unknown;
  removeListener(event:'close',listener:(event:{preventDefault():void})=>void):unknown;
  webContents:{
    on(event:'before-input-event',listener:(event:{preventDefault():void},input:DesktopKeyboardInput)=>void):unknown;
    removeListener(event:'before-input-event',listener:(event:{preventDefault():void},input:DesktopKeyboardInput)=>void):unknown;
  };
}

export interface DesktopWindowActions { hide():unknown; quit():unknown }

export interface DesktopHideGate {
  canHideSafely(): boolean;
  hide(): unknown;
  unavailable(): unknown;
}

/** A handled unavailable Tray is deliberately truthy so native close stays prevented. */
export function requestSafeDesktopHide(gate:DesktopHideGate):unknown{
  if(gate.canHideSafely())return gate.hide();
  void gate.unavailable();
  return true;
}

export function windowsLocalQuit(input:DesktopKeyboardInput):boolean{
  return input.type==='keyDown'&&input.key.toLowerCase()==='q'&&input.control&&!input.alt&&!input.shift&&!input.meta&&!input.isAutoRepeat;
}

export function desktopApplicationMenu(actions:DesktopWindowActions & {reconfigureCredentials?():unknown}):MenuItemConstructorOptions[]{
  return [{label:'Atlas',submenu:[
    ...(actions.reconfigureCredentials ? [{label:'Reconfigurar API key…',click:()=>{void actions.reconfigureCredentials!();}}] : []),
    {label:'Salir de Atlas',accelerator:'CommandOrControl+Q',click:()=>{void actions.quit();}}
  ]}];
}

/** Window-local controls only. Minimize deliberately retains Electron defaults. */
export function registerDesktopWindowControls(target:DesktopWindowControlsTarget,actions:DesktopWindowActions,platform:NodeJS.Platform=process.platform):()=>void{
  const close=(event:{preventDefault():void})=>{const handled=actions.hide();if(handled!==false)event.preventDefault();};
  const input=(event:{preventDefault():void},value:DesktopKeyboardInput)=>{
    if(platform==='win32'&&windowsLocalQuit(value)){event.preventDefault();void actions.quit();}
  };
  target.on('close',close);
  target.webContents.on('before-input-event',input);
  return ()=>{target.removeListener('close',close);target.webContents.removeListener('before-input-event',input);};
}
