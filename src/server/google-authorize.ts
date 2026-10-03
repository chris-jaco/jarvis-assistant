import { createServer } from 'node:http';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { OAuth2Client, CodeChallengeMethod } from 'google-auth-library';
import { googleConfig, saveTokens } from '../tools/adapters/google-auth.js';
try { process.loadEnvFile('.env'); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
const config = googleConfig();
if (!config.clientId || !config.clientSecret) throw new Error('Configure GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in backend .env.');
const redirect = new URL(config.redirectUri);
if (redirect.protocol !== 'http:' || redirect.hostname !== '127.0.0.1' || redirect.pathname !== '/oauth/callback' || !redirect.port || redirect.search || redirect.hash) throw new Error('Use a loopback callback http://127.0.0.1:3001/oauth/callback');
const client = new OAuth2Client(config.clientId, config.clientSecret, config.redirectUri);
const state = randomBytes(32).toString('base64url'), verifier = randomBytes(32).toString('base64url');
let consumed = false;
const server = createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store'); res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  const url = new URL(req.url ?? '/', config.redirectUri);
  const supplied = url.searchParams.get('state') ?? '';
  const suppliedBuffer = Buffer.from(supplied), stateBuffer = Buffer.from(state);
  if (req.method !== 'GET' || url.pathname !== redirect.pathname || consumed || suppliedBuffer.length !== stateBuffer.length || !timingSafeEqual(suppliedBuffer, stateBuffer)) { res.writeHead(400); res.end('Invalid OAuth callback.'); return; }
  consumed = true;
  try {
    const code = url.searchParams.get('code'); if (!code) throw new Error();
    const { tokens } = await client.getToken({ code, codeVerifier: verifier, redirect_uri: config.redirectUri });
    if (!tokens.refresh_token) throw new Error();
    await saveTokens(config.tokenPath, tokens);
    res.end('Google Calendar autorizado. Puedes cerrar esta ventana.'); console.log('Calendar autorizado; tokens guardados en archivo privado.');
  } catch { res.writeHead(400); res.end('No se pudo autorizar Calendar. Reintenta la autorización.'); process.exitCode = 1; }
  finally { clearTimeout(timeout); server.close(); }
});
const timeout = setTimeout(() => { server.close(); console.error('OAuth authorization expired.'); process.exitCode = 1; }, 5 * 60_000);
server.listen(Number(redirect.port), '127.0.0.1', () => {
  console.log('Abre esta URL en el navegador de esta máquina (no contiene tokens):');
  console.log(client.generateAuthUrl({ access_type: 'offline', prompt: 'consent', state,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: CodeChallengeMethod.S256,
    scope: ['https://www.googleapis.com/auth/calendar.events', 'https://www.googleapis.com/auth/calendar.freebusy'] }));
});
