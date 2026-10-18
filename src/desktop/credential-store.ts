import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import type { Stats } from 'node:fs';

export const DESKTOP_CREDENTIAL_IDS = [
  'OPENAI_API_KEY',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET'
] as const;

export type DesktopCredentialId = typeof DESKTOP_CREDENTIAL_IDS[number];
export type DesktopCredentialState = 'MISSING' | 'CONFIGURED' | 'INVALID';
export type DesktopCredentialStatus = Record<DesktopCredentialId, DesktopCredentialState>;

export interface DesktopCredentialCrypto {
  available(): boolean;
  encrypt(value: string): Buffer;
  decrypt(ciphertext: Buffer): string;
}

export interface DesktopCredentialFileSecurity {
  validate(path: string, info: Stats, directory?: boolean, newlyCreated?: boolean): Promise<void>;
}

export type DesktopCredentialStoreErrorCode =
  | 'CREDENTIAL_STORAGE_UNAVAILABLE'
  | 'CREDENTIAL_IDENTIFIER_INVALID'
  | 'CREDENTIAL_VALUE_INVALID'
  | 'CREDENTIAL_STORE_INVALID'
  | 'CREDENTIAL_STORE_IO_FAILED';

export class DesktopCredentialStoreError extends Error {
  constructor(readonly code: DesktopCredentialStoreErrorCode) {
    super(code);
    this.name = 'DesktopCredentialStoreError';
  }
}

interface StoredCredential { ciphertext: string; updatedAt: string }
interface CredentialDocument {
  version: 1;
  provider: 'electron.safeStorage';
  credentials: Partial<Record<DesktopCredentialId, StoredCredential>>;
}

const fileName = 'credentials.v1.json';
const provider = 'electron.safeStorage' as const;
const maxValueBytes = 8_192;
const maxFileBytes = 128 * 1024;
const ids = new Set<string>(DESKTOP_CREDENTIAL_IDS);
const emptyStatus = (): DesktopCredentialStatus => ({
  OPENAI_API_KEY: 'MISSING',
  GOOGLE_CLIENT_ID: 'MISSING',
  GOOGLE_CLIENT_SECRET: 'MISSING'
});

function credentialId(value: unknown): DesktopCredentialId {
  if (typeof value !== 'string' || !ids.has(value)) throw new DesktopCredentialStoreError('CREDENTIAL_IDENTIFIER_INVALID');
  return value as DesktopCredentialId;
}

function credentialValue(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value || /[\u0000-\u001f\u007f]/u.test(value) || Buffer.byteLength(value) > maxValueBytes) {
    throw new DesktopCredentialStoreError('CREDENTIAL_VALUE_INVALID');
  }
  return value;
}

function storedCredential(value: unknown): value is StoredCredential {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some(key => key !== 'ciphertext' && key !== 'updatedAt')) return false;
  if (typeof record.ciphertext !== 'string' || record.ciphertext.length === 0 || record.ciphertext.length > maxFileBytes) return false;
  const decoded = Buffer.from(record.ciphertext, 'base64');
  if (decoded.length === 0 || decoded.toString('base64') !== record.ciphertext) return false;
  return typeof record.updatedAt === 'string' && !Number.isNaN(Date.parse(record.updatedAt));
}

function parseDocument(serialized: string): CredentialDocument {
  if (Buffer.byteLength(serialized) > maxFileBytes) throw new DesktopCredentialStoreError('CREDENTIAL_STORE_INVALID');
  let value: unknown;
  try { value = JSON.parse(serialized); }
  catch { throw new DesktopCredentialStoreError('CREDENTIAL_STORE_INVALID'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new DesktopCredentialStoreError('CREDENTIAL_STORE_INVALID');
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some(key => !['version', 'provider', 'credentials'].includes(key)) || record.version !== 1 || record.provider !== provider || !record.credentials || typeof record.credentials !== 'object' || Array.isArray(record.credentials)) {
    throw new DesktopCredentialStoreError('CREDENTIAL_STORE_INVALID');
  }
  const credentials = record.credentials as Record<string, unknown>;
  if (Object.keys(credentials).some(key => !ids.has(key) || !storedCredential(credentials[key]))) throw new DesktopCredentialStoreError('CREDENTIAL_STORE_INVALID');
  return { version: 1, provider, credentials: credentials as CredentialDocument['credentials'] };
}

export class DesktopCredentialStore {
  readonly path: string;
  private mutations: Promise<void> = Promise.resolve();

  constructor(private readonly options: {
    credentialsRoot: string;
    crypto: DesktopCredentialCrypto;
    security: DesktopCredentialFileSecurity;
    platform?: NodeJS.Platform;
    now?: () => Date;
  }) {
    this.path = join(resolve(options.credentialsRoot), fileName);
  }

  async status(): Promise<DesktopCredentialStatus> {
    await this.mutations;
    if (!this.options.crypto.available()) return this.invalidStatus();
    let document: CredentialDocument | undefined;
    try { document = await this.readDocument(); }
    catch { return this.invalidStatus(); }
    if (!document) return emptyStatus();
    const status = emptyStatus();
    for (const id of DESKTOP_CREDENTIAL_IDS) {
      const stored = document.credentials[id];
      if (!stored) continue;
      try {
        credentialValue(this.options.crypto.decrypt(Buffer.from(stored.ciphertext, 'base64')));
        status[id] = 'CONFIGURED';
      } catch { status[id] = 'INVALID'; }
    }
    return status;
  }

  async set(id: DesktopCredentialId, value: string): Promise<void> {
    const checkedId = credentialId(id);
    const checkedValue = credentialValue(value);
    return this.mutate(async () => {
      this.requireCrypto();
      const document = await this.validDocument();
      let encrypted: Buffer;
      try { encrypted = this.options.crypto.encrypt(checkedValue); }
      catch { throw new DesktopCredentialStoreError('CREDENTIAL_STORAGE_UNAVAILABLE'); }
      if (!Buffer.isBuffer(encrypted) || encrypted.length === 0 || encrypted.indexOf(Buffer.from(checkedValue, 'utf8')) !== -1) throw new DesktopCredentialStoreError('CREDENTIAL_STORAGE_UNAVAILABLE');
      document.credentials[checkedId] = {
        ciphertext: encrypted.toString('base64'),
        updatedAt: (this.options.now ?? (() => new Date()))().toISOString()
      };
      await this.writeDocument(document);
    });
  }

  async delete(id: DesktopCredentialId): Promise<void> {
    const checkedId = credentialId(id);
    return this.mutate(async () => {
      this.requireCrypto();
      const existing = await this.readDocument();
      if (!existing || !existing.credentials[checkedId]) return;
      await this.verifyAll(existing);
      delete existing.credentials[checkedId];
      await this.writeDocument(existing);
    });
  }

  /** Main-only bootstrap boundary. The decrypted value is never returned to a renderer or persisted. */
  async withOpenAIKey<T>(operation: (value: string) => Promise<T>): Promise<T> {
    await this.mutations;
    this.requireCrypto();
    const document = await this.validDocument();
    const stored = document.credentials.OPENAI_API_KEY;
    if (!stored) throw new DesktopCredentialStoreError('CREDENTIAL_STORE_INVALID');
    let value: string;
    try { value = credentialValue(this.options.crypto.decrypt(Buffer.from(stored.ciphertext, 'base64'))); }
    catch { throw new DesktopCredentialStoreError('CREDENTIAL_STORE_INVALID'); }
    return operation(value);
  }

  private invalidStatus(): DesktopCredentialStatus {
    return Object.fromEntries(DESKTOP_CREDENTIAL_IDS.map(id => [id, 'INVALID'])) as DesktopCredentialStatus;
  }

  private requireCrypto(): void {
    if (!this.options.crypto.available()) throw new DesktopCredentialStoreError('CREDENTIAL_STORAGE_UNAVAILABLE');
  }

  private mutate(operation: () => Promise<void>): Promise<void> {
    const next = this.mutations.then(operation, operation);
    this.mutations = next.catch(() => undefined);
    return next;
  }

  private async validDocument(): Promise<CredentialDocument> {
    const document = await this.readDocument() ?? { version: 1, provider, credentials: {} };
    await this.verifyAll(document);
    return document;
  }

  private async verifyAll(document: CredentialDocument): Promise<void> {
    for (const stored of Object.values(document.credentials)) {
      try { credentialValue(this.options.crypto.decrypt(Buffer.from(stored!.ciphertext, 'base64'))); }
      catch { throw new DesktopCredentialStoreError('CREDENTIAL_STORE_INVALID'); }
    }
  }

  private async readDocument(): Promise<CredentialDocument | undefined> {
    let directoryInfo: Stats;
    try { directoryInfo = await lstat(dirname(this.path)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw new DesktopCredentialStoreError('CREDENTIAL_STORE_IO_FAILED');
    }
    try { await this.options.security.validate(dirname(this.path), directoryInfo, true); }
    catch { throw new DesktopCredentialStoreError('CREDENTIAL_STORE_INVALID'); }
    let handle;
    try {
      const info = await lstat(this.path);
      await this.options.security.validate(this.path, info);
      handle = await open(this.path, constants.O_RDONLY | ((this.options.platform ?? process.platform) === 'win32' ? 0 : constants.O_NOFOLLOW));
      await this.options.security.validate(this.path, await handle.stat());
      return parseDocument(await handle.readFile('utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      if (error instanceof DesktopCredentialStoreError) throw error;
      throw new DesktopCredentialStoreError('CREDENTIAL_STORE_IO_FAILED');
    } finally { await handle?.close(); }
  }

  private async writeDocument(document: CredentialDocument): Promise<void> {
    const directory = dirname(this.path);
    let created: string | undefined;
    try { created = await mkdir(directory, { recursive: true, mode: 0o700 }); }
    catch { throw new DesktopCredentialStoreError('CREDENTIAL_STORE_IO_FAILED'); }
    try { await this.options.security.validate(directory, await lstat(directory), true, created !== undefined); }
    catch { throw new DesktopCredentialStoreError('CREDENTIAL_STORE_INVALID'); }
    try {
      const existing = await lstat(this.path);
      await this.options.security.validate(this.path, existing);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        if (error instanceof DesktopCredentialStoreError) throw error;
        throw new DesktopCredentialStoreError('CREDENTIAL_STORE_INVALID');
      }
    }
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    let handle;
    try {
      handle = await open(temporary, 'wx', 0o600);
      await this.options.security.validate(temporary, await handle.stat());
      await handle.writeFile(JSON.stringify(document), 'utf8');
      await handle.sync();
      await handle.close(); handle = undefined;
      await this.options.security.validate(temporary, await lstat(temporary));
      await rename(temporary, this.path);
    } catch (error) {
      if (error instanceof DesktopCredentialStoreError) throw error;
      throw new DesktopCredentialStoreError('CREDENTIAL_STORE_IO_FAILED');
    } finally {
      await handle?.close();
      await unlink(temporary).catch(error => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new DesktopCredentialStoreError('CREDENTIAL_STORE_IO_FAILED');
      });
    }
  }
}
