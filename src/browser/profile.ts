import { mkdir, lstat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { TokenFileSecurity } from '../tools/adapters/token-security.js';
import { BrowserDiagnostics } from './diagnostics.js';
import { ToolError } from '../tools/types.js';

export async function prepareBrowserProfile(root: string, signal: AbortSignal, diagnostics = new BrowserDiagnostics(), security = new TokenFileSecurity()): Promise<string> {
  const profile = resolve(root, '.local/browser-profile');
  // Audit the parent before creating its child. validateMany uses the existing
  // reusable Windows ACL worker: fresh audits, no permission cache or new shell
  // per directory. Retain all owner, DACL, POSIX and reparse-point checks.
  for (const path of [resolve(root, '.local'), profile]) {
    if (signal.aborted) throw new ToolError('TIMEOUT');
    let created = false;
    try { await mkdir(path, { mode: 0o700 }); created = true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    await diagnostics.run('profile_security', async () => security.validateMany([{ path, info: await lstat(path), directory: true, newlyCreated: created }], signal), signal);
  }
  if (signal.aborted) throw new ToolError('TIMEOUT');
  return profile;
}
