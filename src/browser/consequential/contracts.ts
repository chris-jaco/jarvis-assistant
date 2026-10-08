import { z } from 'zod';
import { navigationUrl } from '../policy.js';
const uuid = z.string().uuid();
const origin = z.string().url().max(300).refine(value => { try { const url=new URL(value);return url.protocol==='https:'&&url.origin===value&&navigationUrl(value)===url.href&&!url.username&&!url.password; } catch { return false; } });
export const recipientSchema=z.object({identity:z.string().min(1).max(200),displayName:z.string().min(1).max(120),evidenceId:uuid,uniqueness:z.literal('PROVEN')}).strict();
export const bindingSchema=z.object({backendSessionId:uuid,taskId:uuid,admissionId:uuid,connectionEpoch:uuid,origin,scopeId:uuid,tabId:uuid,documentId:uuid,preparationId:uuid}).strict();
export const candidateSchema=bindingSchema.extend({recipient:recipientSchema,content:z.object({text:z.string().min(1).max(2000)}).strict()}).strict();
export const intentSchema=candidateSchema.extend({intentId:uuid,kind:z.literal('SEND_MESSAGE'),createdAt:z.number().int().positive(),expiresAt:z.number().int().positive(),summary:z.string().min(1).max(4000)}).strict().refine(x=>x.expiresAt>x.createdAt&&x.expiresAt-x.createdAt<=60_000);
export const authorizationSchema=z.object({intentId:uuid,confirmationId:uuid,executionId:uuid,backendSessionId:uuid,bindingDigest:z.string().regex(/^[a-f0-9]{64}$/),deadlineAt:z.number().int().positive()}).strict();
export const stateSchema=z.enum(['RESOLVING','FROZEN','WAITING_CONFIRMATION','REVALIDATING','DISPATCH_RESERVED','EXECUTING','VERIFYING','SUCCESS','FAILURE','UNKNOWN','CANCELLED','REJECTED','EXPIRED','INVALIDATED']);
export const resultSchema=z.object({intentId:uuid,executionId:uuid.optional(),simulationOnly:z.literal(true),execution:z.enum(['NOT_EXECUTED','ACKNOWLEDGED','UNKNOWN']),verification:z.enum(['VERIFIED','FAILED','INCONCLUSIVE']),outcome:z.enum(['CONFIRMED_SUCCESS','CONFIRMED_FAILURE','EXECUTION_UNKNOWN']),reason:z.enum(['SIMULATED_EFFECT','SIMULATED_FAILURE','PRECONDITION_CHANGED','ACCESS_REVOKED','CANCELLED','EXPIRED','TIMEOUT','DISPATCH_UNCERTAIN','JOURNAL_UNAVAILABLE']),evidence:z.enum(['SIMULATED_MESSAGE_ACCEPTED']).optional()}).strict().superRefine((x,ctx)=>{
 if(x.outcome==='CONFIRMED_SUCCESS'&&(x.execution!=='ACKNOWLEDGED'||x.verification!=='VERIFIED'||!x.evidence))ctx.addIssue({code:'custom',message:'Success requires evidence'});
 if(x.outcome==='CONFIRMED_FAILURE'&&x.execution!=='NOT_EXECUTED')ctx.addIssue({code:'custom',message:'Uncertain dispatch is not failure'});
 if(x.outcome==='EXECUTION_UNKNOWN'&&x.verification!=='INCONCLUSIVE')ctx.addIssue({code:'custom',message:'Unknown cannot claim verification'});
});
export type Candidate=z.infer<typeof candidateSchema>;
type DeepReadonly<T>={readonly [K in keyof T]:T[K] extends object?DeepReadonly<T[K]>:T[K]};
export type FrozenIntent=DeepReadonly<z.infer<typeof intentSchema>>;
export type Authorization=z.infer<typeof authorizationSchema>;
export type ActionState=z.infer<typeof stateSchema>;
export type ConsequentialResult=z.infer<typeof resultSchema>;
export interface TrustedContext { candidate:Candidate; chromePermission:boolean; siteAuthorized:boolean; grantValid:boolean; grantExpiresAt:number; }
