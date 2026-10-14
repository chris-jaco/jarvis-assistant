/** Captures only the speech turn that opened admission; late ASR cannot rewrite it. */
export class BrowserTaskAdmission {
  private current?: { id:string; itemId?:string; text?:string; wake?:()=>void };
  private awaitingLate?:{id:string;itemId:string;expiresAt:number};
  constructor(private readonly now=Date.now,private readonly lateWindowMs=10_000) {}
  begin(itemId?:string):void { this.current?.wake?.();this.awaitingLate=undefined;this.current={id:crypto.randomUUID(),itemId}; }
  capture(itemId:string,text:string):{admissionId:string;userTurn:{itemId:string;utterance:string};late:true}|undefined {
    if(!text.trim()||text.length>2000)return;
    if(this.current?.itemId===itemId&&!this.current.text){this.current.text=text;this.current.wake?.();return;}
    if(this.awaitingLate&&this.awaitingLate.expiresAt<=this.now())this.awaitingLate=undefined;
    if(this.awaitingLate?.itemId===itemId){const admissionId=this.awaitingLate.id;this.awaitingLate=undefined;return {admissionId,userTurn:{itemId,utterance:text},late:true};}
  }
  clear():void { this.current?.wake?.();this.current=undefined;this.awaitingLate=undefined; }
  async request(waitMs=1500):Promise<{admissionId:string;userTurn?:{itemId:string;utterance:string};transcriptPending?:true}|undefined> {
    const turn=this.current;if(!turn)return;
    if(turn.itemId&&!turn.text)await new Promise<void>(resolve=>{const timer=setTimeout(resolve,waitMs);turn.wake=()=>{clearTimeout(timer);resolve();};});
    if(this.current!==turn)return;
    this.current=undefined;
    if(turn.itemId&&!turn.text)this.awaitingLate={id:turn.id,itemId:turn.itemId,expiresAt:this.now()+this.lateWindowMs};
    return {admissionId:turn.id,...(turn.itemId&&turn.text?{userTurn:{itemId:turn.itemId,utterance:turn.text}}:turn.itemId?{transcriptPending:true as const}:{})};
  }
}
