import { conversationEvidenceSchema } from '../../../src/browser/consequential/conversation-evidence.js';
import type { ConversationEvidence } from '../../../src/browser/consequential/conversation-evidence.js';
export class WhatsAppSemanticAdapter {
 private handles=new WeakMap<Element,string>();
 constructor(private readonly id:()=>string) {}
 private handle(node:Element):string {let value=this.handles.get(node);if(!value){value=this.id();this.handles.set(node,value);}return value;}
 // Only during an explicit READ. No message contents/old values are captured.
 watch(doc:Document):{changed:()=>boolean;stop:()=>void} {
  let changed=false;const Observer=doc.defaultView?.MutationObserver;
  if(!Observer)return {changed:()=>true,stop:()=>{}};
  const observer=new Observer(()=>{changed=true;});
  for(const node of [...doc.querySelectorAll('[data-testid="conversation-header"],[data-testid="conversation-compose-box-input"],[data-testid*="contact-info"],[data-testid*="drawer"]')].slice(0,16))observer.observe(node,{attributes:true,childList:true,subtree:true,characterData:true});
  return {changed:()=>{if(observer.takeRecords().length)changed=true;return changed;},stop:()=>observer.disconnect()};
 }
 read(doc:Document,visible:(node:HTMLElement)=>boolean,binding:ConversationEvidence['binding']):ConversationEvidence {
  let truncated=false;
  const select=(selector:string,scope:Document|Element=doc)=>{const nodes=scope.querySelectorAll<HTMLElement>(selector),result:HTMLElement[]=[];if(nodes.length>64)truncated=true;for(let n=0;n<Math.min(64,nodes.length);n++)if(visible(nodes[n]!))result.push(nodes[n]!);return result;};
  const panels=select('#main[data-testid="conversation-panel-wrapper"]'),panel=panels.length===1?panels[0]:undefined;
  const headers=panel?select('[data-testid="conversation-header"]',panel):[],composers=panel?select('[data-testid="conversation-compose-box-input"]',panel):[];
  const header=headers.length===1?headers[0]:undefined,composer=composers.length===1?composers[0]:undefined;
  const usableComposer=!!composer&&composer.matches('textarea,[contenteditable="true"][role="textbox"]')&&!composer.closest('[role="search"]');
  const enabled=usableComposer&&!composer!.matches(':disabled')&&!composer!.hasAttribute('readonly')&&composer!.getAttribute('aria-disabled')!=='true'&&composer!.getAttribute('aria-readonly')!=='true';
  // Negative signal only: absence does NOT prove an individual conversation.
  const group=!!header&&/^(group info|informaci[oó]n del grupo)$/i.test(header.getAttribute('aria-label')??'');
  // Generic drawers/dialogs are containers only, never contact evidence.
  // Visibility and conversation exclusion run before any reporting limit.
  const outside=(node:HTMLElement)=>!panel||!panel.contains(node)&&!node.contains(panel);
  const containers=select('[data-testid*="drawer"],[role="dialog"]').filter(outside);
  const specific=select('[data-testid*="contact-info"]').filter(outside);
  // Group by actual containment: choose the nearest eligible structural
  // container, or the specific node itself. No common body/app root fallback.
  const roots=specific.map(node=>containers.filter(container=>container.contains(node))
    .find(container=>!containers.some(inner=>inner!==container&&container.contains(inner)&&inner.contains(node)))??node);
  const unique=[...new Set(roots)];
  const contacts=unique.filter(node=>!unique.some(parent=>parent!==node&&parent.contains(node)));
  const contact=!truncated&&contacts.length===1?contacts[0]:undefined;
  const ambiguous=truncated||panels.length>1||headers.length>1||composers.length>1||contacts.length>1;
  return conversationEvidenceSchema.parse({provenance:{adapter:'whatsapp',version:1},state:!panel&&!ambiguous?'UNAVAILABLE':'INSUFFICIENT_EVIDENCE',reason:ambiguous?'AMBIGUOUS_STRUCTURE':!panel?'NO_ACTIVE_PANEL':group?'GROUP_INDICATED':contact?'CONTACT_BINDING_UNPROVEN':'STRUCTURE_ONLY',conversationKind:group?'GROUP_INDICATED':'NOT_VERIFIED',truncated,activePanelCandidate:!truncated&&!!panel,header:!truncated&&!!header,composer:!truncated&&usableComposer,composerEnabled:!truncated&&!!enabled,contactCandidates:Math.min(3,contacts.length),contactPanel:contact?'CANDIDATE':'NOT_VERIFIED',phoneEvidence:'NOT_VERIFIED',contactAssociation:'NOT_VERIFIED',identity:'NOT_VERIFIED',phoneMatch:'NOT_VERIFIED',handles:truncated?{}:{...(panel?{conversation:this.handle(panel)}:{}),...(header?{header:this.handle(header)}:{}),...(usableComposer?{composer:this.handle(composer!)}:{}),...(contact?{contact:this.handle(contact)}:{})},binding,trust:'UNTRUSTED_PAGE_EVIDENCE'});
 }
}
