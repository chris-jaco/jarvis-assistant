/** Conservative classification of the captured user turn, never tool arguments. */
export type TaskIntent = Readonly<{ intent: 'ACTION_REQUIRED' } | { intent: 'READ_ONLY'; context: 'PAGE' | 'TABS' }>;
export type BrowserDraftGoal='PREPARE_PRIVATE_DRAFT'|'WRITE_DRAFT_TO_COMPOSER';
export type BrowserDraftApplication = Readonly<{ application:'WHATSAPP'; origin:'https://web.whatsapp.com' }>;
/** Application binding from the trusted admission transcript, never DOM/tool input. */
export function classifyBrowserDraftApplication(utterance?: string): BrowserDraftApplication | undefined {
  if (!utterance || utterance.length > 2000) return;
  const text = utterance.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  return /\bwhats\s*app\b/.test(text) ? Object.freeze({ application:'WHATSAPP', origin:'https://web.whatsapp.com' }) : undefined;
}
/** Trusted admission transcript only; page/DOM content never reaches this classifier. */
export function classifyBrowserDraftGoal(utterance?:string):BrowserDraftGoal|undefined {
  if(!utterance||utterance.length>2000)return;
  const text=utterance.normalize('NFD').replace(/\p{M}/gu,'').toLowerCase().replace(/\s+/g,' ').trim();
  const draft=/(?:draft|borrador)/.test(text),message=/(?:mensaje|message)/.test(text),surface=/(?:whatsapp|compositor|composer|conversacion|conversation)/.test(text);
  if(!draft&&!message&&!surface)return;
  if(/(?:borrador privado|private draft|no (?:lo )?escrib\w*(?: en whatsapp)?|sin escribir(?:lo)?(?: en whatsapp)?|only private|solo privado)/.test(text))return 'PREPARE_PRIVATE_DRAFT';
  if(/(?:escrib\w*|write|pon\w*|put|dej\w*)[^.]{0,160}(?:whatsapp|compositor|composer|conversacion|conversation|mensaje|message|borrador|draft)|(?:whatsapp|compositor|composer|conversacion|conversation|mensaje|message|borrador|draft)[^.]{0,160}(?:escrib\w*|write|pon\w*|put|dej\w*)|leave (?:it|the message) as a draft/.test(text))return 'WRITE_DRAFT_TO_COMPOSER';
  return draft?'PREPARE_PRIVATE_DRAFT':undefined;
}
export function classifyTaskIntent(utterance?: string): TaskIntent {
  const action = Object.freeze({ intent: 'ACTION_REQUIRED' as const });
  if (!utterance || utterance.length > 2000) return action;
  const text = utterance.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim()
    .replace(/^[¿¡]/, '').replace(/[?.!]+$/, '').replace(/^atlas[, ]+/, '').replace(/\s+/g, ' ');
  if (/^(?:que pestanas tengo abiertas|que pestanas estan abiertas|listame las pestanas autorizadas|what tabs are open)$/.test(text)) return Object.freeze({ intent: 'READ_ONLY', context: 'TABS' });
  if (/^(?:(?:decime|dime) )?(?:que (?:dice|muestra|contiene) (?:esta|la) pagina|que aparece en (?:esta|la) pantalla|cual es el ultimo mensaje visible|resumime (?:esta pagina|esta conversacion visible|lo que estoy viendo)|resume (?:esta pagina|esta conversacion visible)|what does this page say|summarize this page)$/.test(text)) return Object.freeze({ intent: 'READ_ONLY', context: 'PAGE' });
  return action;
}
