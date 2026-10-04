import { createServer } from 'node:http';
import { OAuthCallback } from './oauth-callback.js';
import { OAuth2Client, CodeChallengeMethod } from 'google-auth-library';
import { googleConfig } from '../tools/adapters/google-auth.js';
import { GmailAccountStore, GMAIL_SCOPES } from '../tools/adapters/gmail-accounts.js';
try { process.loadEnvFile('.env'); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
const config = googleConfig();
if (!config.clientId || !config.clientSecret) throw new Error('Configure GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in backend .env.');
const label = process.argv.slice(2).join(' ').trim();
if (label.length > 80 || /[\r\n\0]/.test(label)) throw new Error('Use an optional display label of at most 80 characters.');
const callback = new OAuthCallback(config.redirectUri);
const redirect = callback.redirect;
const client = new OAuth2Client(config.clientId, config.clientSecret, config.redirectUri);
const accounts = new GmailAccountStore();
const server = createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store'); res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  const url = new URL(req.url ?? '/', config.redirectUri);
  if (!callback.accept(req.method, url)) { res.writeHead(400); res.end('Invalid OAuth callback.'); return; }
  try {
    const code = url.searchParams.get('code'); if (!code) throw new Error();
    const { tokens } = await client.getToken({ code, codeVerifier: callback.verifier, redirect_uri: config.redirectUri });
    if (!tokens.refresh_token || !tokens.id_token) throw new Error();
    const identity = (await client.verifyIdToken({ idToken: tokens.id_token, audience: config.clientId })).getPayload();
    if (!identity?.sub || !identity.email || !identity.email_verified) throw new Error();
    const granted = new Set((tokens.scope ?? '').split(' ')); if (!granted.has('https://www.googleapis.com/auth/gmail.modify')) throw new Error();
    client.setCredentials(tokens);
    const profile = await client.request<{ emailAddress?: string }>({ url: 'https://gmail.googleapis.com/gmail/v1/users/me/profile', timeout: 15_000, retry: false });
    if (profile.data.emailAddress?.toLowerCase() !== identity.email.toLowerCase()) throw new Error();
    callback.ensureActive();
    await accounts.save(identity.sub, identity.email, tokens, label || undefined);
    res.end('Gmail autorizado. Podés cerrar esta ventana.'); console.log('Gmail autorizado; credenciales guardadas en archivo privado independiente.');
  } catch { res.writeHead(400); res.end('No se pudo autorizar Gmail. Reintentá la autorización.'); process.exitCode = 1; }
  finally { clearTimeout(timeout); server.close(); }
});
const timeout = setTimeout(() => { callback.close(); server.close(); console.error('OAuth authorization expired.'); process.exitCode = 1; }, 5 * 60_000);
server.on('error', () => { clearTimeout(timeout); console.error('No se pudo abrir el callback local de OAuth.'); process.exitCode = 1; });
server.listen(Number(redirect.port), '127.0.0.1', () => {
  console.log('Abrí esta URL en el navegador de esta máquina (no contiene tokens):');
  console.log(client.generateAuthUrl({ access_type: 'offline', prompt: 'select_account consent', state: callback.state, scope: GMAIL_SCOPES,
    code_challenge: callback.challenge(), code_challenge_method: CodeChallengeMethod.S256 }));
});
