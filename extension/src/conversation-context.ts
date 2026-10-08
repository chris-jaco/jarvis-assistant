import { semanticContextSchema } from '../../src/browser/consequential/semantic.js';
import type { SemanticContext } from '../../src/browser/consequential/semantic.js';
import { privateText } from '../../src/browser/policy.js';

// Evidence only. No composer values, transcript text, selectors supplied by the
// model, dispatch, credentials, storage or page instructions are read here.
export class ConversationObserver {
  private identities=new WeakMap<Element,string>();
  constructor(private readonly id:()=>string) {}
  private identity(node:Element):string {let id=this.identities.get(node);if(!id){id=this.id();this.identities.set(node,id);}return id;}
  read(doc:Document,origin:string,visible:(node:HTMLElement)=>boolean):SemanticContext {
    const all=[...doc.querySelectorAll<HTMLElement>('[role="log"]')].filter(visible);
    const conversations:SemanticContext['conversations']=[];
    const counts=new Map<string,number>();for(const node of doc.querySelectorAll('[id]'))counts.set(node.id,(counts.get(node.id)??0)+1);
    for(const log of all.slice(0,8)) {
      if(!log.id)continue;
      const ids=(log.getAttribute('aria-labelledby')??'').trim().split(/\s+/);
      if(ids.length!==1||!ids[0])continue;
      const label=doc.getElementById(ids[0]);
      if(!label||!visible(label)||log.contains(label)||label.contains(log))continue;
      // Duplicate IDs make an ARIA relationship ambiguous; never guess.
      const unique=(id:string)=>counts.get(id)===1;
      if(!unique(log.id)||!unique(label.id))continue;
      const names=[...label.querySelectorAll<HTMLElement>('[itemprop="name"]')].filter(visible);
      if(names.length!==1)continue;
      const name=privateText(names[0]!.textContent??'',120);
      if(!name||name==='[redacted]')continue;
      const identifiers:SemanticContext['conversations'][number]['recipient']['identifiers']=[];
      for(const node of [...label.querySelectorAll<HTMLElement>('[itemprop="email"],[itemprop="telephone"]')].slice(0,4)) {
        if(!visible(node))continue;
        const value=(node.textContent??'').trim();const kind=node.getAttribute('itemprop')==='email'?'EMAIL':'PHONE';
        if(value.length<=200&&(kind==='EMAIL'?/^[^\s@]+@[^\s@]+\.[^\s@]+$/:/^\+[1-9][0-9 ()-]{5,24}$/).test(value))identifiers.push({kind,value});
      }
      const controls=[...doc.querySelectorAll<HTMLElement>('[aria-controls]')].filter(n=>n.getAttribute('aria-controls')===log.id&&visible(n));
      const composers=controls.filter(n=>n.matches('textarea,[role="textbox"][contenteditable="true"]')&&!n.closest('[role="search"],form')&&!n.matches(':disabled')&&n.getAttribute('aria-disabled')!=='true');
      const send=controls.filter(n=>n.matches('button,[role="button"]')&&/^(send|enviar)$/i.test(n.getAttribute('aria-label')??''));
      conversations.push({conversationId:this.identity(log),recipient:{name,identifiers},...(composers.length===1?{composerId:this.identity(composers[0]!)}:{}),sendControlIds:send.slice(0,4).map(n=>this.identity(n)),evidence:'EXPLICIT_LABEL_AND_CONTROL_RELATION'});
    }
    const app=doc.querySelector<HTMLElement>('[role="application"][aria-label]');
    return semanticContextSchema.parse({origin,...(app&&visible(app)?{application:privateText(app.getAttribute('aria-label')??'',120)}:{}),conversations,truncated:all.length>8,trust:'UNTRUSTED_PAGE_EVIDENCE'});
  }
}
