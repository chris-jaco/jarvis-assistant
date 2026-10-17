import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { privateRequestPath } from './private-paths.js';
import { createToolsHandler } from './tools.js';
import { createClientSecret, TokenError } from './token.js';
import { desktopApiAuthorized, desktopServerMode } from './desktop-auth.js';
import { coreMayLoadDotEnv } from '../desktop/core-environment.js';
if (coreMayLoadDotEnv(process.env)) {
  try { process.loadEnvFile('.env'); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}
const production = process.argv[1]?.endsWith('.js') ?? false;
const viteApi = production ? undefined : await import('vite');
const vite = viteApi ? await viteApi.createServer({ server: { middlewareMode: true }, appType: 'spa', plugins: [{ name: 'jarvis-private-storage', configResolved(config) { config.server.fs.deny.push('**/.local/**', '**/*google-tokens*.json', '**/g_*.json'); } }] }) : undefined;
const root = resolve(process.env.ATLAS_CLIENT_ROOT ?? 'dist/client');
const mime: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '127.0.0.1';
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT must be an integer from 0 to 65535.');
if (!host.trim()) throw new Error('HOST must not be empty.');
const desktop = desktopServerMode(process.env, host);
const tools = createToolsHandler(process.env, { development: !production });
let tokenPending = false;
let shuttingDown = false;
const server = createServer(async (req, res) => {
  if (privateRequestPath(req.url ?? '')) { res.writeHead(404); res.end(); return; }
  const path = req.url?.split('?')[0];
  if (!desktopApiAuthorized(path ?? '', req.headers, desktop)) {
    res.writeHead(401, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(JSON.stringify({ error: 'Autenticación local requerida.' })); return;
  }
  if (path === '/api/desktop/health') {
    if (req.method !== 'GET') { res.writeHead(405, { Allow: 'GET' }); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify({ ready: true })); return;
  }
  if (path === '/api/desktop/shutdown') {
    if (!desktop.enabled) { res.writeHead(404); res.end(); return; }
    if (req.method !== 'POST') { res.writeHead(405, { Allow: 'POST' }); res.end(); return; }
    res.writeHead(202, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify({ closing: true }));
    setImmediate(() => { void shutdown(); }); return;
  }
  if (await tools.handle(req, res)) return;
  if (path === '/api/realtime/token') {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const send = (status: number, body: unknown) => { res.writeHead(status); res.end(JSON.stringify(body)); };
    if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); send(405, { error: 'Método no permitido.' }); return; }
    const origin = req.headers.origin;
    if ((origin && origin !== `http://${req.headers.host}` && origin !== `https://${req.headers.host}`) || req.headers['sec-fetch-site'] === 'cross-site') {
      send(403, { error: 'Origen no permitido.' }); return;
    }
    if (tokenPending) { send(429, { error: 'Autenticación en curso. Inténtalo de nuevo.' }); return; }
    tokenPending = true;
    try { send(200, await createClientSecret(process.env.OPENAI_API_KEY)); }
    catch (error) { send(error instanceof TokenError ? error.status : 500, { error: error instanceof TokenError ? error.message : 'Error interno de autenticación.' }); }
    finally { tokenPending = false; }
    return;
  }
  if (path?.startsWith('/api/')) { res.writeHead(404); res.end(); return; }
  if (vite) { vite.middlewares(req, res); return; }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return; }
  try {
    const file = resolve(root, `.${decodeURIComponent(path ?? '/') === '/' ? '/index.html' : decodeURIComponent(path ?? '/')}`);
    if (!file.startsWith(root + sep)) { res.writeHead(403); res.end(); return; }
    if (!(await stat(file)).isFile()) { res.writeHead(404); res.end(); return; }
    const body = await readFile(file);
    res.writeHead(200, {
      'Content-Type': mime[extname(file)] ?? 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self' https://api.openai.com wss://api.openai.com; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch { res.writeHead(404); res.end(); }
});
server.listen(port, host, () => {
  const address = server.address(); const actualPort = typeof address === 'object' && address ? address.port : port;
  console.log(`ATLAS: http://${host}:${actualPort}`);
  console.log(`ATLAS_READY ${actualPort}`);
});
async function shutdown(): Promise<void> {
  if (shuttingDown) return; shuttingDown = true; tools.close();
  await new Promise<void>(resolveClose => server.close(() => resolveClose()));
  await vite?.close();
}
process.on('SIGTERM', () => { void shutdown(); });
process.on('SIGINT', () => { void shutdown(); });
