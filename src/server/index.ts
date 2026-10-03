import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { createClientSecret, TokenError } from './token.js';
try { process.loadEnvFile('.env'); } catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
}
const production = process.argv[1]?.endsWith('.js') ?? false;
const vite = production ? undefined : await (await import('vite')).createServer({ server: { middlewareMode: true }, appType: 'spa' });
const root = resolve('dist/client');
const mime: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
let tokenPending = false;
const server = createServer(async (req, res) => {
  const path = req.url?.split('?')[0];
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
    res.writeHead(200, { 'Content-Type': mime[extname(file)] ?? 'application/octet-stream', 'X-Content-Type-Options': 'nosniff' });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch { res.writeHead(404); res.end(); }
});
const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '127.0.0.1';
server.listen(port, host, () => console.log(`JARVIS: http://${host}:${port}`));
async function shutdown(): Promise<void> { server.close(); await vite?.close(); }
process.on('SIGTERM', () => { void shutdown(); });
process.on('SIGINT', () => { void shutdown(); });
