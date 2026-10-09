import { WhatsAppSemanticAdapter } from './whatsapp.js';
// Origin dispatch belongs only in the isolated evidence layer, never provider.
export class SemanticAdapterRegistry {
 private whatsapp:WhatsAppSemanticAdapter;
 constructor(id:()=>string){this.whatsapp=new WhatsAppSemanticAdapter(id);}
 select(origin:string):WhatsAppSemanticAdapter|undefined {return origin==='https://web.whatsapp.com'?this.whatsapp:undefined;}
}
