import { z } from 'zod';
const uuid = z.string().uuid();
export const conversationSchema = z.object({
  conversationId: uuid,
  recipient: z.object({ name: z.string().min(1).max(120), identifiers: z.array(z.object({ kind: z.enum(['EMAIL','PHONE']), value: z.string().min(1).max(200) }).strict()).max(4) }).strict(),
  composerId: uuid.optional(), sendControlIds: z.array(uuid).max(4),
  evidence: z.literal('EXPLICIT_LABEL_AND_CONTROL_RELATION')
}).strict();
export const semanticContextSchema = z.object({
  origin: z.string().url().max(300).refine(x => new URL(x).origin === x),
  application: z.string().max(120).optional(),
  conversations: z.array(conversationSchema).max(8), truncated: z.boolean(),
  trust: z.literal('UNTRUSTED_PAGE_EVIDENCE')
}).strict();
export type SemanticContext = z.infer<typeof semanticContextSchema>;
export type Conversation = z.infer<typeof conversationSchema>;
export const draftRequestSchema = z.object({recipientHint:z.string().min(1).max(120), recipientIdentity:z.string().max(200).optional(), text:z.string().min(1).max(2000)}).strict();
export type DraftRequest = z.infer<typeof draftRequestSchema>;
export type Resolution = {status:'VERIFIED';conversation:Conversation} | {status:'AMBIGUOUS'|'IDENTITY_REQUIRED'|'INSUFFICIENT_EVIDENCE'; candidateCount:number};
// Verification means exact agreement with a user-supplied identifier and an
// explicit visible semantic binding, NOT proof that a website/person is honest.
export function resolveRecipient(context:SemanticContext, request:DraftRequest):Resolution {
  const candidates=context.conversations.filter(c=>c.recipient.name===request.recipientHint);
  if(context.truncated)return {status:'INSUFFICIENT_EVIDENCE',candidateCount:candidates.length};
  if(!request.recipientIdentity)return {status:candidates.length>1?'AMBIGUOUS':'IDENTITY_REQUIRED',candidateCount:candidates.length};
  const matched=candidates.filter(c=>c.recipient.identifiers.some(i=>i.value===request.recipientIdentity));
  if(matched.length>1)return {status:'AMBIGUOUS',candidateCount:matched.length};
  if(matched.length!==1||!matched[0]!.composerId)return {status:'INSUFFICIENT_EVIDENCE',candidateCount:matched.length};
  return {status:'VERIFIED',conversation:matched[0]!};
}
export const draftContextSchema=z.object({
  backendSessionId:uuid,taskId:uuid,admissionId:uuid,connectionEpoch:uuid,
  origin:z.string().url().max(300).refine(x=>new URL(x).protocol==='https:'&&new URL(x).origin===x),
  scopeId:uuid,tabId:uuid,documentId:uuid,snapshotId:uuid,
  snapshotExpiresAt:z.number().int().positive(),grantExpiresAt:z.number().int().positive(),
  chromePermission:z.literal(true),siteAuthorized:z.literal(true),grantValid:z.literal(true),
  requestedIdentifiers:z.array(z.string().min(1).max(200)).max(10),
  semantic:semanticContextSchema
}).strict();
export type DraftContext=z.infer<typeof draftContextSchema>;
