import type { IpcMain } from 'electron';
import { DesktopCredentialStoreError } from './credential-store.js';
import type { DesktopCredentialStore } from './credential-store.js';
import {
  CREDENTIAL_DELETE_OPENAI_CHANNEL,
  CREDENTIAL_PROVISION_OPENAI_CHANNEL,
  CREDENTIAL_STATUS_CHANNEL
} from './credential-setup-api.js';
import type { CredentialSetupError, CredentialSetupResult } from './credential-setup-api.js';

export interface CredentialSetupIpcController { dispose(): void }

function sanitized(error: unknown): CredentialSetupResult {
  let code: CredentialSetupError = 'OPERATION_FAILED';
  if (error instanceof DesktopCredentialStoreError) {
    if (error.code === 'CREDENTIAL_VALUE_INVALID' || error.code === 'CREDENTIAL_IDENTIFIER_INVALID') code = 'INVALID_VALUE';
    else if (error.code === 'CREDENTIAL_STORAGE_UNAVAILABLE') code = 'STORAGE_UNAVAILABLE';
    else if (error.code === 'CREDENTIAL_STORE_INVALID') code = 'STORE_INVALID';
  }
  return { ok: false, state: 'INVALID', error: code };
}

export function registerCredentialSetupIpc(
  ipc: Pick<IpcMain, 'handle' | 'removeHandler'>,
  store: Pick<DesktopCredentialStore, 'status' | 'set' | 'delete'>,
  trustedSender: (senderId: number) => boolean
): CredentialSetupIpcController {
  ipc.handle(CREDENTIAL_STATUS_CHANNEL, async event => {
    if (!trustedSender(event.sender.id)) return sanitized(undefined);
    try { return { ok: true, state: (await store.status()).OPENAI_API_KEY } satisfies CredentialSetupResult; }
    catch (error) { return sanitized(error); }
  });
  ipc.handle(CREDENTIAL_PROVISION_OPENAI_CHANNEL, async (event, value: unknown) => {
    if (!trustedSender(event.sender.id)) return sanitized(undefined);
    if (typeof value !== 'string') return sanitized(new DesktopCredentialStoreError('CREDENTIAL_VALUE_INVALID'));
    try {
      await store.set('OPENAI_API_KEY', value);
      const state = (await store.status()).OPENAI_API_KEY;
      return state === 'CONFIGURED' ? { ok: true, state } satisfies CredentialSetupResult : sanitized(new DesktopCredentialStoreError('CREDENTIAL_STORE_INVALID'));
    } catch (error) { return sanitized(error); }
  });
  ipc.handle(CREDENTIAL_DELETE_OPENAI_CHANNEL, async event => {
    if (!trustedSender(event.sender.id)) return sanitized(undefined);
    try {
      await store.delete('OPENAI_API_KEY');
      const state = (await store.status()).OPENAI_API_KEY;
      return state === 'MISSING' ? { ok: true, state } satisfies CredentialSetupResult : sanitized(new DesktopCredentialStoreError('CREDENTIAL_STORE_INVALID'));
    } catch (error) { return sanitized(error); }
  });
  return {
    dispose() {
      ipc.removeHandler(CREDENTIAL_STATUS_CHANNEL);
      ipc.removeHandler(CREDENTIAL_PROVISION_OPENAI_CHANNEL);
      ipc.removeHandler(CREDENTIAL_DELETE_OPENAI_CHANNEL);
    }
  };
}
