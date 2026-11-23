import { createServer } from 'node:http';
import { CodeChallengeMethod, OAuth2Client } from 'google-auth-library';
import { OAuthCallback } from './oauth-callback.js';
import { GmailAccountStore, GMAIL_SCOPES } from '../tools/adapters/gmail-accounts.js';
import { GoogleReauthorizationRequired, googleConfig, saveTokens } from '../tools/adapters/google-auth.js';

export type GoogleService = 'gmail' | 'calendar';
const calendarScopes = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.freebusy'
];

export interface ConsentActions {
  authorizationUrl: string;
  exchange(code: string): Promise<() => Promise<void>>;
}

/** Owns the existing loopback callback for one explicit authorization attempt. */
export async function runConsent(
  callback: OAuthCallback, actions: ConsentActions,
  openBrowser: (url: string) => Promise<void>, signal?: AbortSignal
): Promise<void> {
  const redirect = callback.redirect;
  const authorization = new URL(actions.authorizationUrl);
  if (authorization.origin !== 'https://accounts.google.com' || authorization.username || authorization.password) {
    throw new Error('GOOGLE_CONSENT_DESTINATION_INVALID');
  }
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let committing = false;
    const server = createServer(async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      let url: URL | undefined;
      try { url = new URL(req.url ?? '/', redirect); } catch { /* reject malformed callbacks */ }
      if (req.headers.host !== redirect.host || !url || !callback.accept(req.method, url)) {
        res.writeHead(400).end('Solicitud inválida.');
        return;
      }
      try {
        const code = url.searchParams.get('code');
        if (!code || url.searchParams.has('error')) throw new Error();
        const save = await actions.exchange(code);
        callback.ensureActive();
        committing = true;
        await save();
        res.end('Autorización completada. Podés volver a Atlas.');
        finish();
      } catch {
        res.writeHead(400).end('La autorización no se completó. Volvé a Atlas.');
        finish('GOOGLE_CONSENT_FAILED');
      }
    });
    const abort = () => { if (!committing) finish('GOOGLE_CONSENT_CANCELLED'); };
    const timer = setTimeout(() => { if (!committing) finish('GOOGLE_CONSENT_EXPIRED'); }, 300_000);
    function finish(code?: string) {
      if (settled) return;
      settled = true;
      callback.close();
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      server.close();
      if (code) {
        server.closeAllConnections();
        reject(new Error(code));
      } else resolve();
    }
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener('abort', abort, { once: true });
    server.once('error', () => finish('GOOGLE_CALLBACK_UNAVAILABLE'));
    server.listen(Number(redirect.port), '127.0.0.1', () => {
      if (!settled) void Promise.resolve().then(() => openBrowser(authorization.href))
        .catch(() => finish('GOOGLE_BROWSER_UNAVAILABLE'));
    });
  });
}

export async function authorizeGoogle(options: {
  service: GoogleService; env: NodeJS.ProcessEnv; label?: string;
  openBrowser: (url: string) => Promise<void>; signal?: AbortSignal;
}): Promise<void> {
  const { service, env, label } = options;
  const config = googleConfig(env);
  if (!config.clientId || !config.clientSecret) throw new Error('GOOGLE_CLIENT_INCOMPLETE');
  if (label && (label.length > 80 || /[\r\n\0]/u.test(label))) throw new Error('GOOGLE_LABEL_INVALID');
  const callback = new OAuthCallback(config.redirectUri);
  const client = new OAuth2Client(config.clientId, config.clientSecret, config.redirectUri);
  const scopes = service === 'gmail' ? GMAIL_SCOPES : calendarScopes;
  const authorizationUrl = client.generateAuthUrl({
    access_type: 'offline', prompt: 'select_account consent', state: callback.state, scope: scopes,
    code_challenge: callback.challenge(), code_challenge_method: CodeChallengeMethod.S256
  });
  await runConsent(callback, {
    authorizationUrl,
    async exchange(code) {
      const { tokens } = await client.getToken({ code, codeVerifier: callback.verifier, redirect_uri: config.redirectUri });
      const granted = new Set(tokens.scope?.split(' '));
      if (!tokens.refresh_token) throw new Error('GOOGLE_REFRESH_UNAVAILABLE');
      if (service === 'calendar') {
        if (!calendarScopes.every(scope => granted.has(scope))) throw new Error('GOOGLE_SCOPE_INCOMPLETE');
        return () => saveTokens(config.tokenPath, tokens);
      }
      if (!tokens.id_token || !granted.has('https://www.googleapis.com/auth/gmail.modify')) throw new Error('GOOGLE_SCOPE_INCOMPLETE');
      const identity = (await client.verifyIdToken({ idToken: tokens.id_token, audience: config.clientId })).getPayload();
      if (!identity?.sub || !identity.email || !identity.email_verified) throw new Error('GOOGLE_IDENTITY_INVALID');
      client.setCredentials(tokens);
      const profile = await client.request<{ emailAddress?: string }>({
        url: 'https://gmail.googleapis.com/gmail/v1/users/me/profile', timeout: 15_000, retry: false
      });
      const { sub, email } = identity;
      if (profile.data.emailAddress?.toLowerCase() !== email.toLowerCase()) throw new Error('GOOGLE_IDENTITY_INVALID');
      return async () => { await new GmailAccountStore(env).save(sub, email, tokens, label); };
    }
  }, options.openBrowser, options.signal);
}

export type GoogleConnectionState = 'VERIFIED' | 'REAUTHORIZE' | 'UNVERIFIED';

/** Explicit, non-mutating access check. An unavailable network is inconclusive.
 * token() may refresh credentials through the existing private store.
 */
export async function checkGoogleConnection(
  service: GoogleService, clientId: string, token: () => Promise<string>, request: typeof fetch = fetch
): Promise<GoogleConnectionState> {
  try {
    const access = await token();
    const info = await request('https://oauth2.googleapis.com/tokeninfo', {
      method: 'POST', headers: { Authorization: 'Bearer ' + access },
      signal: AbortSignal.timeout(10_000), redirect: 'error'
    });
    if (info.status === 401) return 'REAUTHORIZE';
    if (!info.ok) {
      if (info.status === 400 && (await info.json()).error === 'invalid_token') return 'REAUTHORIZE';
      return 'UNVERIFIED';
    }
    const result = await info.json();
    if (typeof result.scope !== 'string' || typeof result.aud !== 'string' ||
        !Number.isFinite(Number(result.expires_in))) return 'UNVERIFIED';
    const required = service === 'gmail' ? ['https://www.googleapis.com/auth/gmail.modify'] : calendarScopes;
    const granted = new Set(result.scope.split(' '));
    return result.aud === clientId && Number(result.expires_in) > 0 && required.every(scope => granted.has(scope))
      ? 'VERIFIED' : 'REAUTHORIZE';
  } catch (error) { return error instanceof GoogleReauthorizationRequired ? 'REAUTHORIZE' : 'UNVERIFIED'; }
}
