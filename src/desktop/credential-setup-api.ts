import type { DesktopCredentialState } from './credential-store.js';

export const CREDENTIAL_STATUS_CHANNEL = 'credentials.status';
export const CREDENTIAL_PROVISION_OPENAI_CHANNEL = 'credentials.provisionOpenAI';
export const CREDENTIAL_DELETE_OPENAI_CHANNEL = 'credentials.deleteOpenAI';

export type CredentialSetupError = 'INVALID_VALUE' | 'STORAGE_UNAVAILABLE' | 'STORE_INVALID' | 'OPERATION_FAILED';
export type CredentialSetupResult =
  | { ok: true; state: DesktopCredentialState }
  | { ok: false; state: 'INVALID'; error: CredentialSetupError };

export interface AtlasCredentialSetupApi {
  status(): Promise<CredentialSetupResult>;
  provisionOpenAI(value: string): Promise<CredentialSetupResult>;
  deleteOpenAI(): Promise<CredentialSetupResult>;
}
