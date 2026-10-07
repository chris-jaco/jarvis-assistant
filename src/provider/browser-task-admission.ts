/** Captures only the speech turn that opened admission; late ASR cannot rewrite it. */
export class BrowserTaskAdmission {
  private current?: { id:string; itemId?:string; text?:string; wake?:()=>void };
  begin(itemId?:string):void { this.current?.wake?.(); this.current={id:crypto.randomUUID(),itemId}; }
  capture(itemId:string,text:string):void { if(this.current?.itemId===itemId&&!this.current.text&&text.length<=2000&&text.trim()){this.current.text=text;this.current.wake?.();} }
  clear():void { this.current?.wake?.();this.current=undefined; }
  async request(waitMs=1500):Promise<{admissionId:string;userTurn?:{itemId:string;utterance:string}}|undefined> {
    const turn=this.current;if(!turn)return;
    if(turn.itemId&&!turn.text)await new Promise<void>(resolve=>{const timer=setTimeout(resolve,waitMs);turn.wake=()=>{clearTimeout(timer);resolve();};});
    if(this.current!==turn)return;
    this.current=undefined;
    return {admissionId:turn.id,...(turn.itemId&&turn.text?{userTurn:{itemId:turn.itemId,utterance:turn.text}}:{})};
  }
}
