import { safeStorage } from 'electron';
import { TokenFileSecurity } from '../tools/adapters/token-security.js';
import { DesktopCredentialStore } from './credential-store.js';

export function createElectronDesktopCredentialStore(credentialsRoot: string): DesktopCredentialStore {
  return new DesktopCredentialStore({
    credentialsRoot,
    crypto: {
      available: () => safeStorage.isEncryptionAvailable(),
      encrypt: value => safeStorage.encryptString(value),
      decrypt: ciphertext => safeStorage.decryptString(ciphertext)
    },
    security: new TokenFileSecurity()
  });
}
