/** Conservative classification of the captured user turn, never tool arguments. */
export type TaskIntent = Readonly<{ intent: 'ACTION_REQUIRED' } | { intent: 'READ_ONLY'; context: 'PAGE' | 'TABS' }>;
export function classifyTaskIntent(utterance?: string): TaskIntent {
  const action = Object.freeze({ intent: 'ACTION_REQUIRED' as const });
  if (!utterance || utterance.length > 2000) return action;
  const text = utterance.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim()
    .replace(/^[¿¡]/, '').replace(/[?.!]+$/, '').replace(/^atlas[, ]+/, '').replace(/\s+/g, ' ');
  if (/^(?:que pestanas tengo abiertas|que pestanas estan abiertas|listame las pestanas autorizadas|what tabs are open)$/.test(text)) return Object.freeze({ intent: 'READ_ONLY', context: 'TABS' });
  if (/^(?:(?:decime|dime) )?(?:que (?:dice|muestra|contiene) (?:esta|la) pagina|que aparece en (?:esta|la) pantalla|cual es el ultimo mensaje visible|resumime (?:esta pagina|esta conversacion visible|lo que estoy viendo)|resume (?:esta pagina|esta conversacion visible)|what does this page say|summarize this page)$/.test(text)) return Object.freeze({ intent: 'READ_ONLY', context: 'PAGE' });
  return action;
}
