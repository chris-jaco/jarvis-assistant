import { createServer } from 'node:http';
import { readFile, realpath } from 'node:fs/promises';
import { resolve, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { transform } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
export const defaultRoot = resolve(here, '../../.local/wake-word-spike');
export async function loadAssets(root = defaultRoot) {
  // Import checked TS through the existing compiler without adding a production dependency.
  const source = await readFile(resolve(here, 'core.ts'), 'utf8');
  const js = (await transform(source, { loader: 'ts', target: 'es2022', format: 'esm' })).code;
  const { checkManifest } = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);
  const manifest = JSON.parse(await readFile(resolve(root, 'manifest.json'), 'utf8'));
  checkManifest(manifest);
  const canonicalRoot = await realpath(root);
  const files = new Map();
  for (const asset of manifest.files) {
    const path = await realpath(resolve(root, asset.name));
    if (!path.startsWith(canonicalRoot + sep)) throw Error('ASSET_PATH_INVALID');
    const bytes = await readFile(path);
    if (bytes.length !== asset.bytes || createHash('sha256').update(bytes).digest('hex') !== asset.sha256) throw Error('ASSET_CORRUPT');
    files.set(`/assets/${asset.name}`, bytes);
  }
  return { manifest, files };
}
export async function startServer(port = 4317) {
  const files = new Map();
  let assetsReady = false;
  try {
    const assets = await loadAssets();
    files.set('/manifest.json', Buffer.from(JSON.stringify(assets.manifest)));
    for (const entry of assets.files) files.set(...entry);
    assetsReady = true;
  } catch { /* Serve the harness, but loading/recording remains blocked until preparation succeeds. */ }
  for (const name of ['index.html', 'worker.mjs', 'pcm-worklet.js', 'browser.ts', 'core.ts', 'signal.ts', 'wav.ts', 'trace.ts']) {
    const text = await readFile(resolve(here, name), 'utf8');
    files.set('/' + name.replace(/\.ts$/, '.js'), Buffer.from(name.endsWith('.ts')
      ? (await transform(text, { loader: 'ts', target: 'es2022', format: 'esm' })).code : text));
  }
  files.set('/', files.get('/index.html'));
  const server = createServer((request, response) => {
    const address = server.address();
    const host = `127.0.0.1:${address.port}`;
    const common = {
      'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
      'Permissions-Policy': 'microphone=(self), camera=()', 'Referrer-Policy': 'no-referrer'
    };
    if (request.method !== 'GET' || request.headers.host !== host
      || (request.headers.origin && request.headers.origin !== `http://${host}`)
      || request.headers['sec-fetch-site'] === 'cross-site') {
      response.writeHead(403, common).end('REQUEST_REJECTED'); return;
    }
    const url = new URL(request.url, `http://${host}`);
    const body = files.get(url.pathname);
    if (!body || url.search) { response.writeHead(404, common).end('ASSET_UNAVAILABLE'); return; }
    const type = url.pathname.endsWith('.wasm') ? 'application/wasm' : /\.(m?js)$/.test(url.pathname) ? 'text/javascript' : url.pathname.endsWith('.json') ? 'application/json' : url.pathname === '/' || url.pathname.endsWith('.html') ? 'text/html' : 'application/octet-stream';
    response.writeHead(200, { ...common, 'Content-Type': `${type}${type.startsWith('text/') ? '; charset=utf-8' : ''}` }).end(body);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return { server, assetsReady, url: `http://127.0.0.1:${server.address().port}` };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await startServer();
    console.log(`Experimental personal-only harness: ${result.url}`);
    console.log(result.assetsReady ? 'Local assets verified. No audio is stored.' : 'MODEL_MISSING_OR_INVALID: run prepare.mjs before loading the engine.');
  } catch { console.error('SPIKE_SERVER_FAILED'); process.exitCode = 1; }
}
