/** Conservative classification of the captured user turn, never tool arguments. */
export type TaskIntent = Readonly<{ intent: 'ACTION_REQUIRED' } | { intent: 'READ_ONLY'; context: 'PAGE' | 'TABS' }>;
export type BrowserDraftGoal='PREPARE_PRIVATE_DRAFT'|'WRITE_DRAFT_TO_COMPOSER';
/** Trusted admission transcript only; page/DOM content never reaches this classifier. */
export function classifyBrowserDraftGoal(utterance?:string):BrowserDraftGoal|undefined {
  if(!utterance||utterance.length>2000)return;
  const text=utterance.normalize('NFD').replace(/\p{M}/gu,'').toLowerCase().replace(/\s+/g,' ').trim();
  if(!/whatsapp/.test(text)||!/(?:draft|borrador)/.test(text))return;
  if(/(?:write|put|escrib\w*|pon\w*)[^.]{0,80}\b(?:in|into|en) (?:whatsapp|the composer|el compositor)|leave (?:it|the message) as a draft|deja(?:lo|r)? (?:escrito )?(?:como |en )?(?:el )?borrador/.test(text))return 'WRITE_DRAFT_TO_COMPOSER';
  return 'PREPARE_PRIVATE_DRAFT';
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
