import { z } from 'zod';
export const MAX_PAYLOAD = 65_536;
export const uuid = z.string().uuid();
const empty = z.object({}).strict();
export const reasons = z.enum(['CAPTCHA', 'AUTHENTICATION', 'MFA', 'CHALLENGE', 'ORIGIN_PERMISSION', 'UNSUPPORTED_CONTROL', 'MEDIA_USER_GESTURE']);
export const conflictSchema = z.object({ reason: z.enum(['SNAPSHOT_CONSUMED', 'SNAPSHOT_EXPIRED', 'DOCUMENT_CHANGED', 'ELEMENT_CHANGED']), execution: z.literal('NOT_EXECUTED') }).strict();
export const timingSchema = z.object({ queueMs: z.number().min(0).max(30_000).optional(), injectionMs: z.number().min(0).max(30_000).optional(), initializationMs: z.number().min(0).max(30_000).optional(), observationBuildMs: z.number().min(0).max(30_000).optional(), returnMs: z.number().min(0).max(30_000).optional(), transportMs: z.number().min(0).max(30_000).optional() }).strict();
export type BrowserTimings = z.infer<typeof timingSchema>;
export type BrowserConflictDetail = z.infer<typeof conflictSchema>;
export const errors = z.enum(['INVALID_INPUT', 'ACCESS_DENIED', 'CONTENT_UNAVAILABLE', 'EXPIRED', 'STALE_REF', 'DISCONNECTED', 'TIMEOUT', 'UNSUPPORTED', 'REJECTED', 'EXECUTION_UNKNOWN']);
export const binding = z.object({ scopeId: uuid, tabId: uuid }).strict();
export const refBinding = binding.extend({ documentId: uuid, snapshotId: uuid, ref: uuid }).strict();
const url = z.string().url().max(2000);
export const accessArgs = z.object({ target: z.discriminatedUnion('kind', [z.object({ kind: z.literal('current') }).strict(), z.object({ kind: z.literal('new'), url }).strict()]), purpose: z.string().min(1).max(160), lifetime: z.enum(['task', 'session']).default('task') }).strict();
export const argumentSchemas = {
  status: empty, listAuthorizedTabs: empty, requestTabAccess: accessArgs,
  revokeTabAccess: z.object({ scopeId: uuid }).strict(), openTab: z.object({ accessRequestId: uuid }).strict(),
  navigate: binding.extend({ url }).strict(), observe: binding.extend({ resumeHandoffId: uuid.optional() }).strict(),
  click: refBinding, type: refBinding.extend({ text: z.string().min(1).max(500), mode: z.enum(['replace', 'append']) }).strict(),
  press: refBinding.extend({ key: z.enum(['Enter', 'Escape', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space']) }).strict(),
  scroll: binding.extend({ direction: z.enum(['up', 'down']) }).strict(), back: binding, forward: binding, reload: binding,
  media: refBinding.extend({ action: z.enum(['play', 'pause']) }).strict(), activate: binding,
  endSession: empty, endTask: empty
} as const;
export type Operation = keyof typeof argumentSchemas;
const envelope = z.object({ protocol: z.literal('atlas.browser'), version: z.literal(1), kind: z.literal('request'), requestId: uuid, backendSessionId: uuid, taskId: uuid, connectionEpoch: uuid, deadlineAt: z.number().int().positive() });
export const requestSchema = z.discriminatedUnion('operation', Object.entries(argumentSchemas).map(([operation, args]) => envelope.extend({ operation: z.literal(operation), args }).strict()) as unknown as [z.ZodObject, z.ZodObject, ...z.ZodObject[]]);
export interface Request { protocol: 'atlas.browser'; version: 1; kind: 'request'; requestId: string; backendSessionId: string; taskId: string; connectionEpoch: string; deadlineAt: number; operation: Operation; args: Record<string, unknown> }
export const tabSchema = z.object({ id: uuid, scopeId: uuid, title: z.string().max(120), url: z.string().max(300), active: z.boolean(), expiresAt: z.number().int(), state: z.enum(['ACTIVE', 'MANUAL_INTERVENTION', 'SUSPENDED_ORIGIN', 'SUSPENDED_CONNECTION']) }).strict();
export type AuthorizedTab = z.infer<typeof tabSchema>;
export const functionalKindSchema = z.enum(['SEARCH_INPUT','SEARCH_SUBMIT','RESULT_LINK','NAVIGATION_LINK','MEDIA_ELEMENT','MEDIA_PLAY','MEDIA_PAUSE','AD_SKIP','BLOCKED']);
export const capabilitySchema = z.enum(['TYPE_SEARCH','SUBMIT_SEARCH','OPEN_LINK','PLAY','PAUSE','SKIP_AD']);
export const mediaSchema = z.object({ presence: z.enum(['NONE','AVAILABLE']), playback: z.enum(['UNKNOWN','LOADING','PLAYING','PAUSED','ENDED','BUFFERING','ERROR']), advertisement: z.enum(['UNKNOWN','DETECTED']), skipAvailable: z.boolean() }).strict();
export const elementSchema = z.object({ functionalKind: functionalKindSchema.optional(), capabilities: z.array(capabilitySchema).max(3).optional(), ref: uuid, role: z.string().max(30), name: z.string().max(120), type: z.string().max(20), disabled: z.boolean(), action: z.enum(['navigation', 'search', 'media', 'consent', 'blocked']), state: z.object({ paused: z.boolean().optional(), checked: z.boolean().optional(), expanded: z.boolean().optional() }).strict().optional() }).strict();
export const observationSchema = z.object({ media: mediaSchema.optional(), tabId: uuid, scopeId: uuid, documentId: uuid, snapshotId: uuid, expiresAt: z.number().int().positive(), url: z.string().max(300), title: z.string().max(120), elements: z.array(elementSchema).max(40), truncated: z.boolean(), dialog: z.object({ role: z.string().max(30), name: z.string().max(120) }).strict().optional() }).strict().refine(value => JSON.stringify(value).length <= 12_000);
export type AttachedObservation = z.infer<typeof observationSchema>;
export const observationResultSchema = z.discriminatedUnion('status', [z.object({ status: z.literal('OK'), data: observationSchema }).strict(), z.object({ status: z.literal('FAILED'), reason: z.enum([...errors.options, ...reasons.options, ...conflictSchema.shape.reason.options, 'OBSERVATION_REQUIRED', 'STEP_PENDING', 'UPSTREAM']) }).strict()]);
export type ObservationResult = z.infer<typeof observationResultSchema>;
export interface InteractionResult { action: { status: 'COMPLETED' }; result: unknown; observation: ObservationResult; requiresFreshObservation: boolean }
const status = z.object({ available: z.boolean(), connected: z.boolean(), visible: z.literal(true), connections: z.array(uuid).max(10) }).strict();
const ack = z.object({ completed: z.literal(true), paused: z.boolean().optional() }).strict();
export const replySchema = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('OK'), timings: timingSchema.optional(), data: z.union([status, tabSchema, z.array(tabSchema).max(20), observationSchema, ack]) }).strict(),
  z.object({ outcome: z.literal('ACCESS_PENDING'), timings: timingSchema.optional(), accessRequestId: uuid, expiresAt: z.number().int().positive() }).strict(),
  z.object({ outcome: z.literal('REQUIRES_USER_INTERACTION'), timings: timingSchema.optional(), handoffId: uuid, reason: reasons }).strict(),
  z.object({ outcome: z.literal('ERROR'), timings: timingSchema.optional(), code: errors, conflict: conflictSchema.optional() }).strict().refine(reply => !reply.conflict || reply.code === 'STALE_REF')
]);
export type Reply = z.infer<typeof replySchema>;
export const helloSchema = z.object({ protocol: z.literal('atlas.browser'), version: z.literal(1), kind: z.literal('hello'), connectionEpoch: uuid }).strict();
export const cancelSchema = z.object({ protocol: z.literal('atlas.browser'), version: z.literal(1), kind: z.literal('cancel'), requestId: uuid, backendSessionId: uuid, connectionEpoch: uuid }).strict();
export const responseSchema = z.object({ protocol: z.literal('atlas.browser'), version: z.literal(1), kind: z.literal('response'), requestId: uuid, backendSessionId: uuid, connectionEpoch: uuid, reply: replySchema }).strict();
export const eventSchema = z.object({ protocol: z.literal('atlas.browser'), version: z.literal(1), kind: z.literal('event'), connectionEpoch: uuid, backendSessionId: uuid, event: z.enum(['accessGranted', 'accessRevoked', 'documentChanged']), accessRequestId: uuid.optional(), tab: tabSchema.optional(), scopeId: uuid.optional() }).strict();
export function parseRequest(raw: unknown): Request { return requestSchema.parse(raw) as unknown as Request; }
