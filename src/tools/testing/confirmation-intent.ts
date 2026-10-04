import type { ConfirmationIntent } from '../confirmation-intent.js';
// Fake model outcomes ONLY for deterministic state-machine tests. Production has
// no phrase table; semantic accuracy must also be checked with live acceptance.
export const naturalApprovals = ['Perfecto, te confirmo el envío.', 'Perfecto, confirmo.', 'Sí, te confirmo el envío.', 'Confirmado.', 'Dale, confirmo.', 'Sí, adelante.', 'Perfecto, envíalo.', 'Sí, mandalo.', 'Sí, mandáselo.', 'Te confirmo.', 'Confirmo el envío.', 'Dale.', 'Adelante.', 'Hacelo.', 'Perfecto.'];
const approvals = [...naturalApprovals, 'sí', 'sí, confirma', 'confirmar', 'adelante', 'hazlo', 'sí, hazlo', 'sí, sí, te confirmo', 'Sí, sí, te confirmo. Envíaselo, por favor.', 'Sí, envíaselo', 'Sí, envíalo', 'sí, te confirmo, envíaselo por favor', 'confirmo', 'señor confirmo', 'Sí, confirmo.'];
const negatives = ['no', 'No.', 'cancelar', 'cancela', 'no lo hagas', 'No lo envíes'];
export function fakeIntent(utterance: string): ConfirmationIntent {
  if (approvals.some(p => p.toLowerCase() === utterance.toLowerCase())) return 'affirmative';
  if (negatives.some(p => p.toLowerCase() === utterance.toLowerCase())) return 'negative';
  if (utterance === 'No sé si sí o no') return 'ambiguous';
  return 'unrelated';
}
