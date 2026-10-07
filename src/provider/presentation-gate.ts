import { BrowserTaskDiagnostics, type BrowserTaskTrace } from '../diagnostics/browser-task.js';
import type { BrowserExecutionState } from '../browser/execution-state.js';
interface ResponseAdmission {
  allowed: boolean;
  accepted: boolean;
  tools: boolean;
  message?: string;
  generation: number;
}
// Presentation only: no capture-track changes, response cancellation or tool
// scheduling. One initial response may acknowledge; subsequent work is silent.
export class PresentationGate {
  private generation = 0;
  private state?: BrowserExecutionState;
  private accepted = false;
  private ordinaryPermit = false;
  private active?: string;
  private playing?: string;
  private userPermit = false;
  private responses = new Map<string, ResponseAdmission>();
  private items = new Map<string, { allowed: boolean }>();
  private internalItems = new Set<string>();
  constructor(private readonly muteOutput: (muted: boolean) => void,private readonly diagnostics=new BrowserTaskDiagnostics(),private readonly playbackInfo:()=>{visibility?:'visible'|'hidden'|'prerender';paused?:boolean;ended?:boolean}=()=>({})) { this.setMute(true,'INITIAL'); }
  private trace(raw:Partial<BrowserTaskTrace>):void {if(!this.diagnostics.enabled)return;let info={};try{info=this.playbackInfo();}catch{/* Instrumentation cannot interfere with playback. */}this.diagnostics.event({...raw,taskState:this.state,...info});}
  private setMute(muted:boolean,muteReason:BrowserTaskTrace['muteReason'],id=this.active):void {this.muteOutput(muted);this.trace({stage:'PRESENTATION',muted,muteReason,...(id&&/^resp_[A-Za-z0-9_-]{1,100}$/.test(id)?{responseId:id}:{})});}
  playbackEvent(playback:'STARTED'|'STOPPED'|'CLEARED',id?:string):void {if(playback!=='STARTED'&&(!id||id===this.playing))this.playing=undefined;this.trace({stage:'PLAYBACK',playback,...(id&&/^resp_[A-Za-z0-9_-]{1,100}$/.test(id)?{responseId:id}:{})});}
  internal(id: string): void {
    this.internalItems.add(id);
    while (this.internalItems.size > 1000) this.internalItems.delete(this.internalItems.values().next().value!);
  }
  userVisible(id: string): boolean { return !this.internalItems.has(id); }
  turn(confirmationActive = false): void {
    if (confirmationActive || ['WAITING_ACCESS','WAITING_MANUAL'].includes(this.state ?? '')) return;
    if (this.state === 'RUNNING' || this.state === 'RECOVERING_CONTEXT') { ++this.generation; this.active=undefined; this.playing=undefined; this.userPermit=true; this.setMute(true,'TURN_RUNNING'); return; }
    ++this.generation; this.active = undefined; this.state = 'TASK_ACCEPTED'; this.accepted = false; this.ordinaryPermit = false; this.setMute(true,'TURN_ACCEPTED');
  }
  update(state: BrowserExecutionState): void { this.state = state; if(state==='RUNNING'||state==='RECOVERING_CONTEXT')this.ordinaryPermit=false; }
  beginBrowser(): void {
    this.update('RUNNING');
    const response = this.active ? this.responses.get(this.active) : undefined;
    // An acknowledgement already created belongs to the accepted response.
    // A tool-first response cannot acquire acknowledgement eligibility later.
    if (response && !response.message) response.allowed = false;
    if (!response?.allowed && !this.audible(this.playing)) this.setMute(true,'BEGIN_BROWSER');
  }
  tool(id = this.active): void {
    const response = id ? this.responses.get(id) : undefined;
    if (response) { response.tools = true; if (response.accepted && !response.message) response.allowed = false; }
  }
  response(id: string, internal = false): void {
    if (this.responses.has(id)) return;
    const user = !internal && this.userPermit; if (user) this.userPermit=false;
    const accepted = user || !internal && !this.accepted && (!this.state || this.state === 'TASK_ACCEPTED');
    if (accepted) this.accepted = true;
    const allowed = user || accepted || this.ordinaryPermit || !!this.state && !['RUNNING','RECOVERING_CONTEXT','TASK_ACCEPTED'].includes(this.state);
    this.ordinaryPermit = false;
    this.responses.set(id, { allowed, accepted, tools: false, generation: this.generation });
    this.active = id;
    while (this.responses.size > 256) this.responses.delete(this.responses.keys().next().value!);
    if (!this.audible(this.playing)) this.setMute(true,'RESPONSE_CREATED',id);
    else this.trace({stage:'PRESENTATION',muted:false,muteReason:'RESPONSE_CREATED',...(/^resp_[A-Za-z0-9_-]{1,100}$/.test(id)?{responseId:id}:{})});
  }
  item(responseId: string, item: string, type = 'message'): void {
    if (this.items.has(item)) return;
    const response = this.responses.get(responseId);
    if (type === 'function_call') { this.tool(responseId); return; }
    const allowed = !!response?.allowed && (!response.accepted || !response.tools && !response.message);
    if (response?.accepted) {
      if (allowed) response.message = item;
      else { response.allowed = false; this.setMute(true,'EXTRA_MESSAGE',responseId); }
    }
    this.items.set(item, { allowed });
    while (this.items.size > 1000) this.items.delete(this.items.keys().next().value!);
  }
  visible(item: string): boolean { return this.items.get(item)?.allowed === true; }
  audible(id?: string): boolean { return !!(id && this.responses.get(id)?.allowed && this.responses.get(id)?.generation === this.generation); }
  playback(id?: string): void { this.playing=id; this.setMute(!this.audible(id),'PLAYBACK_ELIGIBILITY',id); }
  done(id: string): boolean {
    if (this.active === id) this.active = undefined;
    const response=this.responses.get(id);
    if (response?.generation===this.generation && response.tools && (!this.state || this.state==='TASK_ACCEPTED')) this.ordinaryPermit=true;
    // No second model roundtrip to replay/replace an initial response. Tool
    // execution starts independently of acknowledgement playback/completion.
    return false;
  }
  close(): void { this.responses.clear(); this.items.clear(); this.internalItems.clear(); this.state = undefined; this.active = undefined; this.playing=undefined;this.userPermit=false; this.setMute(true,'CLOSE'); }
}
