import { createHash } from 'node:crypto';
import { lstat, readdir, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import type { Credentials } from 'google-auth-library';
import { GoogleAuth, googleConfig, readTokens, saveTokens } from './google-auth.js';
import { TokenFileSecurity } from './token-security.js';
import { ToolError } from '../types.js';
export const GMAIL_SCOPES = ['openid', 'email', 'https://www.googleapis.com/auth/gmail.modify'];
export const accountIdSchema = z.string().regex(/^g_[a-f0-9]{32}$/);
const metadata = z.object({ id: accountIdSchema, subject: z.string().min(1).max(255), email: z.string().email().max(254), label: z.string().min(1).max(80).optional() }).strict();
export type GmailAccount = Omit<z.infer<typeof metadata>, 'subject'>;
interface StoredCredentials extends Credentials { jarvisAccount: z.infer<typeof metadata> }
export interface GmailAccounts { list(): Promise<GmailAccount[]>; get(id?: string): Promise<GmailAccount>; token(id: string): Promise<string> }
export function gmailAccountId(subject: string): string { return `g_${createHash('sha256').update(subject).digest('hex').slice(0, 32)}`; }
export class GmailAccountStore implements GmailAccounts {
  readonly directory: string;
  private clients = new Map<string, { fingerprint: string; auth: GoogleAuth }>();
  constructor(private readonly env: NodeJS.ProcessEnv = process.env, private readonly security = new TokenFileSecurity()) {
    this.directory = resolve(env.GMAIL_ACCOUNTS_PATH ?? '.local/gmail-accounts');
  }
  private async safeParents(): Promise<void> {
    // Existing POSIX helper protects the immediate token directory; also reject
    // symlink ancestors for nested multi-account paths (Windows checks reparse points).
    let cursor = this.directory;
    for (;;) {
      try { if ((await lstat(cursor)).isSymbolicLink()) throw new ToolError('UNCONFIGURED'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      const parent = dirname(cursor); if (parent === cursor) break; cursor = parent;
    }
  }
  private path(id: string): string { return resolve(this.directory, `${accountIdSchema.parse(id)}.json`); }
  private async credentials(id: string): Promise<StoredCredentials> {
    try {
      await this.safeParents();
      const value = await readTokens(this.path(id), this.security) as StoredCredentials;
      const parsed = metadata.parse(value.jarvisAccount);
      if (parsed.id !== id || gmailAccountId(parsed.subject) !== id || !value.refresh_token) throw new Error();
      return { ...value, jarvisAccount: parsed };
    } catch { throw new ToolError('UNCONFIGURED'); }
  }
  async list(): Promise<GmailAccount[]> {
    try {
      await this.safeParents();
      await this.security.validate(this.directory, await lstat(this.directory), true);
      const files = (await readdir(this.directory)).filter(name => /^g_[a-f0-9]{32}\.json$/.test(name));
      if (files.length > 20) throw new ToolError('LIMIT');
      return Promise.all(files.sort().map(async name => this.public((await this.credentials(name.slice(0, -5))).jarvisAccount)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error instanceof ToolError ? error : new ToolError('UNCONFIGURED');
    }
  }
  private public(value: z.infer<typeof metadata>): GmailAccount { return { id: value.id, email: value.email, ...(value.label ? { label: value.label } : {}) }; }
  async get(id?: string): Promise<GmailAccount> {
    if (id) return this.public((await this.credentials(id)).jarvisAccount);
    const accounts = await this.list();
    if (!accounts.length) throw new ToolError('UNCONFIGURED');
    if (accounts.length !== 1) throw new ToolError('AMBIGUOUS');
    return accounts[0]!;
  }
  async token(id: string): Promise<string> {
    const credentials = await this.credentials(id); // Removed/insecure accounts cannot reuse a cached credential.
    const fingerprint = createHash('sha256').update(credentials.refresh_token!).digest('hex');
    let client = this.clients.get(id);
    if (!client || client.fingerprint !== fingerprint) {
      client = { fingerprint, auth: new GoogleAuth({ ...googleConfig(this.env), tokenPath: this.path(id) }) };
      this.clients.set(id, client);
    }
    return client.auth.token();
  }
  async save(subject: string, email: string, tokens: Credentials, label?: string): Promise<GmailAccount> {
    try {
      await this.safeParents();
      const existing = await this.list();
      if (existing.length >= 20 && !existing.some(a => a.id === gmailAccountId(subject))) throw new ToolError('LIMIT');
      const value = metadata.parse({ id: gmailAccountId(subject), subject, email: email.trim().toLowerCase(), ...(label ? { label } : {}) });
      if (!tokens.refresh_token) throw new Error();
      await saveTokens(this.path(value.id), { ...tokens, jarvisAccount: value } as StoredCredentials, this.security);
      this.clients.delete(value.id); return this.public(value);
    } catch { throw new ToolError('UNCONFIGURED'); }
  }
  async remove(id: string): Promise<void> { await this.credentials(id); await unlink(this.path(id)); this.clients.delete(id); }
}
