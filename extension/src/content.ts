import { backendSender } from './senders.js';
import { z } from 'zod';
import { ContentEngine } from './content-engine.js';
import { uuid, parseRequest } from '../../src/browser/attached/protocol.js';
const root = globalThis as typeof globalThis & { __atlasContentInstalled?: boolean };
if (!root.__atlasContentInstalled) {
  root.__atlasContentInstalled = true;
  const engine = new ContentEngine(window);
  const init = z.object({ kind: z.literal('init'), access: z.object({ scopeId: uuid, tabId: uuid, session: uuid, epoch: uuid, origin: z.string().url(), expiresAt: z.number().int().positive() }).strict() }).strict();
  chrome.runtime.onMessage.addListener((raw, sender, send) => {
    if (!backendSender(sender, chrome.runtime.id)) return false;
    try {
      if (raw?.kind === 'revoke' && Object.keys(raw).length === 1) { engine.revoke(); send({ completed: true }); return false; }
      if (raw?.kind === 'documentChanged' && Object.keys(raw).length === 1) { engine.documentChanged(); send({ completed: true }); return false; }
      if (raw?.kind === 'init') { engine.initialize(init.parse(raw).access); send({ completed: true }); return false; }
      const request = parseRequest(raw);
      void engine.run(request.operation, request.args, request.deadlineAt, { session: request.backendSessionId, epoch: request.connectionEpoch }).then(send).catch(() => send({ outcome: 'ERROR', code: 'UNSUPPORTED' })); return true;
    } catch { send({ outcome: 'ERROR', code: 'ACCESS_DENIED' }); return false; }
  });
}
