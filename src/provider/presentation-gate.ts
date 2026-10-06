import type { BrowserExecutionState } from '../browser/execution-state.js';
// This gate owns presentation only. It never cancels responses/tools, changes
// capture tracks, or removes SDK conversation history.
export class PresentationGate {
  private generation=0;
  private state?:BrowserExecutionState;
  private admission=true;
  private ordinaryPermit=false;
  private responses=new Map<string,{allowed:boolean;admission:boolean;tools:boolean;generation:number}>();
  private items=new Map<string,{allowed:boolean}>();
  private internalItems=new Set<string>();
  internal(id:string):void{this.internalItems.add(id);while(this.internalItems.size>1000)this.internalItems.delete(this.internalItems.values().next().value!);}
  userVisible(id:string):boolean{return !this.internalItems.has(id);}
  private active?:string;
  constructor(private readonly muteOutput:(muted:boolean)=>void){muteOutput(true);}
  turn(confirmationActive=false):void {
    if(confirmationActive || this.state==='WAITING_MANUAL' || this.state==='WAITING_ACCESS')return;
    if(this.state==='RUNNING')return;
    ++this.generation;this.active=undefined;this.state=undefined;this.admission=true;this.ordinaryPermit=false;this.muteOutput(true);
  }
  update(state:BrowserExecutionState):void {this.state=state;this.admission=false; /* Never release an existing suppressed response. */}
  beginBrowser():void {this.update('RUNNING');if(this.active){const response=this.responses.get(this.active);if(response)response.allowed=false;}this.muteOutput(true);}
  tool():void {if(this.active){const response=this.responses.get(this.active);if(response)response.tools=true;}}
  response(id:string):void {
    if(this.responses.has(id))return;
    const allowed=this.state!==undefined?this.state!=='RUNNING':this.ordinaryPermit;
    this.responses.set(id,{allowed,admission:this.admission&&!this.ordinaryPermit,tools:false,generation:this.generation});this.active=id;this.ordinaryPermit=false;
    while(this.responses.size>256)this.responses.delete(this.responses.keys().next().value!);
    this.muteOutput(true);
  }
  item(response:string,item:string):void {if(this.items.has(item))return;this.items.set(item,this.responses.get(response)??{allowed:false});while(this.items.size>1000)this.items.delete(this.items.keys().next().value!);}
  visible(item:string):boolean{return this.items.get(item)?.allowed===true;}
  audible(id?:string):boolean{return !!(id&&this.responses.get(id)?.allowed&&this.responses.get(id)?.generation===this.generation);}
  playback(id?:string):void {this.muteOutput(!this.audible(id));}
  done(id:string):boolean {
    const response=this.responses.get(id);if(this.active===id)this.active=undefined;
    if(response?.generation!==this.generation)return false;
    if(response?.admission&&!response.tools&&this.state===undefined){this.admission=false;this.ordinaryPermit=true;return true;}
    // A response with a non-browser tool gets one fresh ordinary output after
    // the tool result. Browser state remains authoritative if it was admitted.
    if(response?.admission&&response.tools&&this.state===undefined){this.admission=false;this.ordinaryPermit=true;}
    return false;
  }
  close():void{this.responses.clear();this.items.clear();this.internalItems.clear();this.state=undefined;this.active=undefined;this.muteOutput(true);}
}
