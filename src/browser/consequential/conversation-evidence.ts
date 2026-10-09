import { z } from 'zod';
// Evidence, never approval. This first adapter has no identity-proof branch.
export const conversationEvidenceSchema=z.object({
 provenance:z.object({adapter:z.literal('whatsapp'),version:z.literal(1)}).strict(),
 state:z.enum(['OBSERVED','UNAVAILABLE','INSUFFICIENT_EVIDENCE','INVALIDATED']),
 reason:z.enum(['STRUCTURE_ONLY','NO_ACTIVE_PANEL','AMBIGUOUS_STRUCTURE','GROUP_INDICATED','CONTEXT_CHANGED','CONTACT_BINDING_UNPROVEN']),
 conversationKind:z.enum(['NOT_VERIFIED','GROUP_INDICATED']),
 truncated:z.boolean(),activePanelCandidate:z.boolean(),header:z.boolean(),composer:z.boolean(),composerEnabled:z.boolean(),
 contactCandidates:z.number().int().min(0).max(3),contactPanel:z.enum(['NOT_VERIFIED','CANDIDATE']),phoneEvidence:z.enum(['NOT_VERIFIED','PRESENT']),
 contactAssociation:z.literal('NOT_VERIFIED'),identity:z.literal('NOT_VERIFIED'),phoneMatch:z.literal('NOT_VERIFIED'),
 handles:z.object({conversation:z.string().uuid().optional(),header:z.string().uuid().optional(),composer:z.string().uuid().optional(),contact:z.string().uuid().optional()}).strict(),
 binding:z.object({tabId:z.string().uuid(),scopeId:z.string().uuid(),documentId:z.string().uuid(),epoch:z.string().uuid()}).strict(),
 trust:z.literal('UNTRUSTED_PAGE_EVIDENCE')
}).strict();
export type ConversationEvidence=z.infer<typeof conversationEvidenceSchema>;
// Model/page evidence cannot assert VERIFIED; future proof contracts need review.
export function assessConversationEvidence(raw:unknown):{status:'INSUFFICIENT_EVIDENCE';reason:'IDENTITY_NOT_VERIFIED'} {
 conversationEvidenceSchema.parse(raw);return {status:'INSUFFICIENT_EVIDENCE',reason:'IDENTITY_NOT_VERIFIED'};
}
