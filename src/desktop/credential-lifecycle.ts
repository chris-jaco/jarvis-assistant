import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { DesktopCleanupOutcome } from './lifecycle-coordinator.js';
import type { DesktopCredentialState } from './credential-store.js';

const documentVersion = 1;

export function shouldShowCredentialSetup(state: DesktopCredentialState, requested: boolean): boolean {
  return state !== 'CONFIGURED' || requested;
}

export class CredentialSetupPreference {
  readonly path: string;
  private mutations: Promise<void> = Promise.resolve();

  constructor(configRoot: string) {
    this.path = join(configRoot, 'credential-setup.v1.json');
  }

  async required(): Promise<boolean> {
    await this.mutations;
    try {
      const value: unknown = JSON.parse(await readFile(this.path, 'utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value)) return true;
      const record = value as Record<string, unknown>;
      if (Object.keys(record).some(key => key !== 'version' && key !== 'showOnNextStart')) return true;
      if (record.version !== documentVersion || typeof record.showOnNextStart !== 'boolean') return true;
      return record.showOnNextStart;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      // A corrupt preference fails toward showing setup, never toward starting Core.
      return true;
    }
  }

  request(): Promise<void> { return this.write(true); }
  clear(): Promise<void> { return this.write(false); }

  private write(showOnNextStart: boolean): Promise<void> {
    const operation = this.mutations.then(async () => {
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      let handle;
      try {
        handle = await open(temporary, 'wx', 0o600);
        await handle.writeFile(JSON.stringify({ version: documentVersion, showOnNextStart }), 'utf8');
        await handle.sync();
        await handle.close(); handle = undefined;
        await rename(temporary, this.path);
      } finally {
        await handle?.close();
        await unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
      }
    });
    this.mutations = operation.catch(() => undefined);
    return operation;
  }
}

export async function requestCredentialReconfiguration(dependencies: {
  cleanup(): Promise<DesktopCleanupOutcome>;
  persistPreference(): Promise<void>;
  quit(): Promise<void>;
  restore(): void;
  showFailure(): Promise<void>;
}): Promise<boolean> {
  const outcome = await dependencies.cleanup();
  if (outcome !== 'COMPLETED') return false;
  try { await dependencies.persistPreference(); }
  catch {
    dependencies.restore();
    await dependencies.showFailure();
    return false;
  }
  await dependencies.quit();
  return true;
}
