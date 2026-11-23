export const CORE_BOOTSTRAP_PROTOCOL = 'atlas.core-bootstrap/2' as const;
export const CORE_BOOTSTRAP_MAX_CREDENTIAL_BYTES = 8_192;

export interface GoogleClientCredentials {
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
}

export type CoreCredentials = { OPENAI_API_KEY: string } & Partial<GoogleClientCredentials>;

export interface CoreBootstrapRequest {
  protocol: typeof CORE_BOOTSTRAP_PROTOCOL;
  kind: 'CREDENTIALS';
  generation: string;
  credentials: CoreCredentials;
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

export function validGoogleClientId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 512 && /^[A-Za-z0-9-]+\.apps\.googleusercontent\.com$/u.test(value);
}
export function validGoogleClientSecret(value: unknown): value is string {
  return validOpenAICredential(value) && /^[A-Za-z0-9_.-]+$/u.test(value);
}

export function parseCoreBootstrapRequest(value: unknown): CoreBootstrapRequest | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (!exactKeys(record, ['protocol', 'kind', 'generation', 'credentials']) || record.protocol !== CORE_BOOTSTRAP_PROTOCOL || record.kind !== 'CREDENTIALS' || !validCoreBootstrapGeneration(record.generation)) return undefined;
  if (!record.credentials || typeof record.credentials !== 'object' || Array.isArray(record.credentials)) return undefined;
  const credentials = record.credentials as Record<string, unknown>;
  if (!validOpenAICredential(credentials.OPENAI_API_KEY)) return undefined;
  if (!exactKeys(credentials, ['OPENAI_API_KEY']) &&
      !(exactKeys(credentials, ['OPENAI_API_KEY', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET']) &&
        validGoogleClientId(credentials.GOOGLE_CLIENT_ID) && validGoogleClientSecret(credentials.GOOGLE_CLIENT_SECRET))) return undefined;
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

export function createCoreBootstrapRequest(generation: string, openAIKey: string, google?: GoogleClientCredentials): CoreBootstrapRequest {
  const request: CoreBootstrapRequest = {
    protocol: CORE_BOOTSTRAP_PROTOCOL, kind: 'CREDENTIALS', generation,
    credentials: { OPENAI_API_KEY: openAIKey, ...google }
  };
  if (!parseCoreBootstrapRequest(request)) throw new Error('DESKTOP_CORE_BOOTSTRAP_INVALID');
  return request;
}
