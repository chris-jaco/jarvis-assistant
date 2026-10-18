export const CORE_BOOTSTRAP_PROTOCOL = 'atlas.core-bootstrap/1' as const;
export const CORE_BOOTSTRAP_MAX_CREDENTIAL_BYTES = 8_192;

export interface CoreBootstrapRequest {
  protocol: typeof CORE_BOOTSTRAP_PROTOCOL;
  kind: 'CREDENTIALS';
  generation: string;
  credentials: { OPENAI_API_KEY: string };
}

export type CoreBootstrapRejectReason = 'INVALID_MESSAGE' | 'GENERATION_MISMATCH' | 'DUPLICATE';
export type CoreBootstrapAck =
  | { protocol: typeof CORE_BOOTSTRAP_PROTOCOL; kind: 'ACK'; generation: string; status: 'ACCEPTED' }
  | { protocol: typeof CORE_BOOTSTRAP_PROTOCOL; kind: 'ACK'; generation: string; status: 'REJECTED'; reason: CoreBootstrapRejectReason };

const generationPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const exactKeys = (value: Record<string, unknown>, expected: readonly string[]) => {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === [...expected].sort()[index]);
};

export function validCoreBootstrapGeneration(value: unknown): value is string {
  return typeof value === 'string' && generationPattern.test(value);
}

export function validOpenAICredential(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.trim() === value &&
    !/[\u0000-\u001f\u007f]/u.test(value) && Buffer.byteLength(value) <= CORE_BOOTSTRAP_MAX_CREDENTIAL_BYTES;
}

export function parseCoreBootstrapRequest(value: unknown): CoreBootstrapRequest | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (!exactKeys(record, ['protocol', 'kind', 'generation', 'credentials']) || record.protocol !== CORE_BOOTSTRAP_PROTOCOL || record.kind !== 'CREDENTIALS' || !validCoreBootstrapGeneration(record.generation)) return undefined;
  if (!record.credentials || typeof record.credentials !== 'object' || Array.isArray(record.credentials)) return undefined;
  const credentials = record.credentials as Record<string, unknown>;
  if (!exactKeys(credentials, ['OPENAI_API_KEY']) || !validOpenAICredential(credentials.OPENAI_API_KEY)) return undefined;
  return value as CoreBootstrapRequest;
}

export function parseCoreBootstrapAck(value: unknown): CoreBootstrapAck | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.protocol !== CORE_BOOTSTRAP_PROTOCOL || record.kind !== 'ACK' || !validCoreBootstrapGeneration(record.generation)) return undefined;
  if (record.status === 'ACCEPTED' && exactKeys(record, ['protocol', 'kind', 'generation', 'status'])) return value as CoreBootstrapAck;
  if (record.status === 'REJECTED' && exactKeys(record, ['protocol', 'kind', 'generation', 'status', 'reason']) && ['INVALID_MESSAGE', 'GENERATION_MISMATCH', 'DUPLICATE'].includes(String(record.reason))) return value as CoreBootstrapAck;
  return undefined;
}

export function createCoreBootstrapRequest(generation: string, openAIKey: string): CoreBootstrapRequest {
  if (!validCoreBootstrapGeneration(generation) || !validOpenAICredential(openAIKey)) throw new Error('DESKTOP_CORE_BOOTSTRAP_INVALID');
  return { protocol: CORE_BOOTSTRAP_PROTOCOL, kind: 'CREDENTIALS', generation, credentials: { OPENAI_API_KEY: openAIKey } };
}
