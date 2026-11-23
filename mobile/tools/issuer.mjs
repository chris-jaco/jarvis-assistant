// Run only on the trusted development PC. Never imported by Metro.
import { randomInt, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { JARVIS_SPEAKING_STYLE, JARVIS_VOICE, REALTIME_MODEL, TURN_EAGERNESS } from '../../src/core/personality.ts';

export function createIssuer(pin, mint) {
  let consumed = false;
  let rejected = 0;
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const supplied = Buffer.from(req.headers.authorization ?? '');
    const expected = Buffer.from('Bearer ' + pin);
    if (consumed || req.method !== 'POST' || req.url !== '/token' || req.headers.origin ||
        supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      res.writeHead(403).end();
      if (++rejected >= 5 && !consumed) { consumed = true; server.close(); }
      return;
    }
    consumed = true;
    server.close();
    try {
      const value = await mint();
      if (typeof value !== 'string' || !value.startsWith('ek_')) throw new Error();
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ value }));
    } catch { res.writeHead(502).end(); }
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  return server;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const key = process.env.ATLAS_ANDROID_DEV_OPENAI_KEY;
  if (!key || !process.stdout.isTTY || !process.stdin.isTTY) throw new Error('Emisor interactivo con clave de desarrollo requerido.');
  delete process.env.ATLAS_ANDROID_DEV_OPENAI_KEY;
  const pin = String(randomInt(10_000_000, 100_000_000));
  const server = createIssuer(pin, async () => {
    const response = await fetch('https://api.openai.com/v1/realtime/client_secrets', {
      method: 'POST', signal: AbortSignal.timeout(12_000),
      headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ expires_after: { anchor: 'created_at', seconds: 60 }, session: {
        type: 'realtime', model: REALTIME_MODEL, instructions: JARVIS_SPEAKING_STYLE,
        tools: [], output_modalities: ['audio'], audio: {
          input: { turn_detection: { type: 'semantic_vad', eagerness: TURN_EAGERNESS, interrupt_response: true, create_response: true } },
          output: { voice: JARVIS_VOICE }
        }
      } })
    });
    if (!response.ok) throw new Error();
    return (await response.json()).value;
  });
  const expiry = setTimeout(() => { server.close(); server.closeAllConnections(); }, 60_000);
  server.on('close', () => { clearTimeout(expiry); process.stdout.write('\r\x1b[2K'); });
  server.on('error', () => { clearTimeout(expiry); process.exitCode = 1; console.error('Emisor local no disponible.'); });
  server.listen(8765, '127.0.0.1', () => process.stdout.write('Código USB por 60 segundos: ' + pin));
}
