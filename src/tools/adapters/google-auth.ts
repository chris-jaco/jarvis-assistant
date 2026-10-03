import { OAuth2Client } from 'google-auth-library';
import type { Credentials } from 'google-auth-library';
import { mkdir, readFile, rename, writeFile, lstat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ToolError } from '../types.js';
export interface GoogleConfig { clientId?: string; clientSecret?: string; tokenPath: string; redirectUri: string }
export async function saveTokens(path: string, tokens: Credentials): Promise<void> {
  const dir = dirname(resolve(path)); await mkdir(dir, { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(tokens), { mode: 0o600, flag: 'wx' }); await rename(temporary, path);
}
export class GoogleAuth {
  private loading?: Promise<OAuth2Client>;
  private writes: Promise<void> = Promise.resolve();
  constructor(private readonly config: GoogleConfig) {}
  async token(): Promise<string> {
    try {
      const client = await (this.loading ??= this.load());
      const token = await client.getAccessToken(); await this.writes;
      if (!token.token) throw new ToolError('UNCONFIGURED');
      return token.token;
    } catch { this.loading = undefined; throw new ToolError('UNCONFIGURED'); }
  }
  private async load(): Promise<OAuth2Client> {
    if (!this.config.clientId || !this.config.clientSecret) throw new ToolError('UNCONFIGURED');
    const info = await lstat(this.config.tokenPath);
    if (!info.isFile() || (info.mode & 0o077) !== 0) throw new ToolError('UNCONFIGURED');
    const credentials = JSON.parse(await readFile(this.config.tokenPath, 'utf8')) as Credentials;
    if (!credentials.refresh_token) throw new ToolError('UNCONFIGURED');
    const client = new OAuth2Client(this.config.clientId, this.config.clientSecret, this.config.redirectUri);
    client.setCredentials(credentials);
    client.on('tokens', tokens => {
      Object.assign(credentials, tokens);
      this.writes = this.writes.then(() => saveTokens(this.config.tokenPath, credentials));
      // Handle rejected persistence immediately; token() reports it safely.
      void this.writes.catch(() => undefined);
    });
    return client;
  }
}
export function googleConfig(env: NodeJS.ProcessEnv = process.env): GoogleConfig {
  return { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET, tokenPath: resolve(env.GOOGLE_TOKEN_PATH ?? '.local/google-tokens.json'), redirectUri: env.GOOGLE_REDIRECT_URI ?? 'http://127.0.0.1:3001/oauth/callback' };
}
