import { popupSender } from './senders.js';
import { ExtensionController } from './controller.js';
import { helloSchema, cancelSchema, responseSchema, MAX_PAYLOAD } from '../../src/browser/attached/protocol.js';
import { contentRequest } from './content-transport.js';
import { z } from 'zod';
let port: chrome.runtime.Port | undefined; let reconnect: ReturnType<typeof setTimeout> | undefined; let delay = 500;
const invalidate = async (tab: number, documentOnly = false) => { await chrome.tabs.sendMessage(tab, { kind: documentOnly ? 'documentChanged' : 'revoke' }, { frameId: 0 }).catch(() => {}); };
const controller = new ExtensionController({
  current: async () => { const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }); if (tab?.id === undefined || !tab.url) throw new Error('ACCESS_DENIED'); return { id: tab.id, url: tab.url, title: tab.title ?? '' }; },
  create: async url => { const tab = await chrome.tabs.create({ url, active: true }); if (tab.id === undefined) throw new Error('UNSUPPORTED'); return tab.id; },
  activate: async id => { await chrome.tabs.update(id, { active: true }); },
  navigate: async (id, url) => { await chrome.tabs.update(id, { url, active: true }); },
  history: async (id, action) => { if (action === 'reload') await chrome.tabs.reload(id); else if (action === 'back') await chrome.tabs.goBack(id); else await chrome.tabs.goForward(id); },
  invalidate,
  content: (id, grant, request) => contentRequest(chrome, () => controller.epoch, id, grant, request)
}, message => { if (port) { try { port.postMessage(message); } catch { /* Disconnect resets grants below. */ } } void badge(); });
async function badge() { await chrome.action.setBadgeText({ text: controller.pending().length ? '?' : controller.authorized().length ? 'ON' : '' }); await chrome.action.setBadgeBackgroundColor({ color: '#35E6D0' }); }
function connect(): void {
  clearTimeout(reconnect);
  try {
    const connected = chrome.runtime.connectNative('com.atlas.browser_bridge'); port = connected;
    connected.onMessage.addListener(raw => {
      if (new TextEncoder().encode(JSON.stringify(raw)).length > MAX_PAYLOAD) { connected.disconnect(); return; }
      void (async () => {
        try {
          if (raw?.kind === 'hello') { await controller.reset(helloSchema.parse(raw)); delay = 500; }
          else if (raw?.kind === 'cancel') controller.cancel(cancelSchema.parse(raw));
          else {
            const reply = await controller.receive(raw);
            if (raw?.kind === 'request' && typeof raw.requestId === 'string' && controller.epoch === raw.connectionEpoch) {
              const response = responseSchema.safeParse({ protocol: 'atlas.browser', version: 1, kind: 'response', requestId: raw.requestId, backendSessionId: raw.backendSessionId, connectionEpoch: controller.epoch, reply });
              if (response.success && port === connected) connected.postMessage(response.data);
            }
          }
        } catch { connected.disconnect(); }
        await badge();
      })();
    });
    connected.onDisconnect.addListener(() => { void chrome.runtime.lastError; if (port !== connected) return; port = undefined; void controller.reset().then(badge); reconnect = setTimeout(connect, delay); delay = Math.min(delay * 2, 5000); });
  } catch { reconnect = setTimeout(connect, delay); delay = Math.min(delay * 2, 5000); }
}
const popupRequest = z.discriminatedUnion('action', [z.object({ action: z.literal('state') }).strict(), ...['approve','revoke','renew','deny'].map(action => z.object({ action: z.literal(action), id: z.string().uuid() }).strict())] as unknown as [z.ZodObject, z.ZodObject, ...z.ZodObject[]]);
chrome.runtime.onMessage.addListener((raw, sender, send) => {
  // Only our packaged popup can authorize. Content scripts/pages cannot.
  if (!popupSender(sender, chrome.runtime.id, chrome.runtime.getURL('popup.html'))) return false;
  void (async () => { try {
    const message = popupRequest.parse(raw);
    if (message.action === 'approve') await controller.approve(message.id as string);
    if (message.action === 'revoke') await controller.revoke(message.id as string);
    if (message.action === 'renew') await controller.renew(message.id as string);
    if (message.action === 'deny') controller.tickets.delete(message.id as string);
    await badge(); const [current] = await chrome.tabs.query({ active: true, currentWindow: true }); const currentOrigin = current?.url && /^https?:/.test(current.url) ? new URL(current.url).origin : 'Página no soportada'; send({ currentOrigin, connected: !!port && !!controller.epoch, pending: controller.pending(), authorized: controller.authorized() });
  } catch { send({ error: 'No se pudo autorizar. Seleccioná la pestaña correcta, abrí el icono de Atlas y reintentá.' }); } })(); return true;
});
chrome.tabs.onRemoved.addListener(id => { for (const grant of controller.grants.values()) if (grant.chromeId === id) void controller.revoke(grant.scopeId).then(badge); });
chrome.tabs.onUpdated.addListener((id, change) => { if (change.status === 'loading') void controller.documentChanged(id); });
setInterval(() => { controller.expire(); void badge(); }, 10_000);
connect();
