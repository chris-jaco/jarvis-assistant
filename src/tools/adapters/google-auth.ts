import { OAuth2Client } from 'google-auth-library';
import type { Credentials } from 'google-auth-library';
import { mkdir, rename, open, lstat, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { constants } from 'node:fs';
import { TokenFileSecurity } from './token-security.js';
import { randomUUID } from 'node:crypto';
import { ToolError } from '../types.js';
export interface GoogleConfig { clientId?: string; clientSecret?: string; tokenPath: string; redirectUri: string }
export async function saveTokens(path: string, tokens: Credentials, security = new TokenFileSecurity()): Promise<void> {
  path = resolve(path);
  const dir = dirname(path);
  const created = await mkdir(dir, { recursive: true, mode: 0o700 });
  await security.validate(dir, await lstat(dir), true, created !== undefined);
  try { await security.validate(path, await lstat(path)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const temporary = `${path}.${randomUUID()}.tmp`;
  let handle;
  try {
    // Create empty first. Verify its inherited ACL/mode before writing secrets.
    handle = await open(temporary, 'wx', 0o600);
    await security.validate(temporary, await handle.stat());
    await handle.writeFile(JSON.stringify(tokens));
    await handle.sync();
    await handle.close(); handle = undefined;
    await rename(temporary, path);
  } finally {
    await handle?.close();
    await unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
  }
}
export async function readTokens(path: string, security = new TokenFileSecurity()): Promise<Credentials> {
  path = resolve(path);
  await security.validate(dirname(path), await lstat(dirname(path)), true);
  await security.validate(path, await lstat(path));
  const handle = await open(path, constants.O_RDONLY | (security.platform === 'win32' ? 0 : constants.O_NOFOLLOW));
  try {
    await security.validate(path, await handle.stat());
    return JSON.parse(await handle.readFile('utf8')) as Credentials;
  } finally { await handle.close(); }
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
    const credentials = await readTokens(this.config.tokenPath);
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
