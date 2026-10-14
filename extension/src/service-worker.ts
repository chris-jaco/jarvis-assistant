import { resolveActiveTab, resolvePopupActiveTab, activeTabErrors } from './active-tab.js';
import { PopupDiagnostics } from '../../src/diagnostics/popup.js';
const accessDiagnostics=new PopupDiagnostics(undefined,true);
void chrome.storage.local.get('atlasPopupDiagnostics').then(value=>{accessDiagnostics.enabled=value.atlasPopupDiagnostics===true;}).catch(()=>{accessDiagnostics.enabled=false;});
import { SiteAuthorization, hostPattern } from './site-authorization.js';
import { chromeSiteEnvironment } from './site-storage.js';
import { popupSender } from './senders.js';
import { ExtensionController } from './controller.js';
import { helloSchema, cancelSchema, responseSchema, MAX_PAYLOAD } from '../../src/browser/attached/protocol.js';
import { contentRequest } from './content-transport.js';
import { z } from 'zod';
let port: chrome.runtime.Port | undefined; let reconnect: ReturnType<typeof setTimeout> | undefined; let delay = 500;
const invalidate = async (tab: number, documentOnly = false) => { await chrome.tabs.sendMessage(tab, { kind: documentOnly ? 'documentChanged' : 'revoke' }, { frameId: 0 }).catch(() => {}); };
const sites = new SiteAuthorization(chromeSiteEnvironment(chrome), origin => controller.revokeOrigin(origin));
const controller = new ExtensionController({
  observeAuthorization:async grant=>{const tab=await chrome.tabs.get(grant.chromeId);if(!tab.url)throw new Error();const origin=new URL(tab.url).origin;return {...await sites.diagnosticStatus(origin),sameOrigin:origin===grant.origin};},
  tab: async id => { const tab = await chrome.tabs.get(id); return { id, windowId:tab.windowId, url: tab.url ?? '', title: tab.title, status: tab.status, pendingUrl: tab.pendingUrl }; },
  current: () => resolveActiveTab(() => chrome.tabs.query({ active: true })),
  eligible: async origin => (await chrome.tabs.query({url:[hostPattern(origin)]})).flatMap(tab => tab.id !== undefined && Number.isInteger(tab.windowId) && tab.url && new URL(tab.url).origin === origin ? [{id:tab.id,windowId:tab.windowId,url:tab.url,title:tab.title??''}] : []),
  create: async url => { const tab = await chrome.tabs.create({ url, active: true }); if (tab.id === undefined) throw new Error('UNSUPPORTED'); return {id:tab.id,windowId:tab.windowId}; },
  activate: async id => { await chrome.tabs.update(id, { active: true }); },
  navigate: async (id, url) => { await chrome.tabs.update(id, { url, active: true }); },
  history: async (id, action) => { if (action === 'reload') await chrome.tabs.reload(id); else if (action === 'back') await chrome.tabs.goBack(id); else await chrome.tabs.goForward(id); },
  invalidate,
  content: (id, grant, request) => contentRequest(chrome, () => controller.epoch, id, grant, request),
  clearManualSelection:async(id,manualRequestId)=>{await chrome.tabs.sendMessage(id,{kind:'clearManualSelection',manualRequestId},{frameId:0});},
  selectConversation:async (id,grant,epoch,manualRequestId,taskId,admissionId,expectedDocumentId)=>{
    const injected=await chrome.scripting.executeScript({target:{tabId:id,frameIds:[0]},world:'ISOLATED',files:['content.js']});
    const documentId=injected.find(row=>row.frameId===0)?.documentId;
    const target=documentId?{documentId}:{frameId:0};
    const access={scopeId:grant.scopeId,tabId:grant.tabId,session:grant.session,epoch,origin:grant.origin,expiresAt:grant.expiresAt};
    const initialized=await chrome.tabs.sendMessage(id,{kind:'init',access},target);
    if(initialized?.completed!==true)return false;
    // Re-check the mutable controller authority immediately before publishing
    // evidence. A cancel/expiry/reconnect may have won while injection awaited.
    if(controller.epoch!==epoch||controller.grants.get(grant.scopeId)!==grant||grant.manualRequest?.id!==manualRequestId||grant.manualRequest.admissionId!==admissionId||grant.task!==taskId){
      await chrome.tabs.sendMessage(id,{kind:'clearManualSelection',manualRequestId},target).catch(()=>{});return false;
    }
    const selected=await chrome.tabs.sendMessage(id,{kind:'selectConversation',access,manualRequestId,taskId,admissionId,expectedDocumentId},target);
    const tab=await chrome.tabs.get(id);
    return selected?.selected===true&&!tab.pendingUrl&&!!tab.url&&new URL(tab.url).origin===grant.origin;
  }
}, message => { if (port) { try { port.postMessage(message); } catch { /* Disconnect resets grants below. */ } } void badge(); }, Date.now, () => crypto.randomUUID(), sites,accessDiagnostics);
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
const popupRequest = z.discriminatedUnion('action', [
  z.object({ correlationId:z.string().uuid().optional(),windowId:z.number().int().nonnegative(),action: z.literal('state') }).strict(),
  z.object({ correlationId:z.string().uuid().optional(),windowId:z.number().int().nonnegative(),action: z.literal('approve'), id: z.string().uuid(), origin: z.string().url().max(300), always: z.boolean() }).strict(),
  z.object({ correlationId:z.string().uuid().optional(),windowId:z.number().int().nonnegative(),action: z.literal('revokeSite'), origin: z.string().url().max(300) }).strict(),
  z.object({correlationId:z.string().uuid().optional(),windowId:z.number().int().nonnegative(),action:z.literal('selectConversation'),id:z.string().uuid()}).strict(),
  z.object({correlationId:z.string().uuid().optional(),windowId:z.number().int().nonnegative(),action:z.literal('selectAccessTab'),id:z.string().uuid(),candidateId:z.string().uuid()}).strict(),
  ...['revoke','renew','deny','cancelManualSelection'].map(action => z.object({ correlationId:z.string().uuid().optional(),windowId:z.number().int().nonnegative(),action: z.literal(action), id: z.string().uuid() }).strict())
] as unknown as [z.ZodObject, z.ZodObject, ...z.ZodObject[]]);
chrome.runtime.onMessage.addListener((raw, sender, send) => {
  // Only our packaged popup can authorize. Content scripts/pages cannot.
  if (!popupSender(sender, chrome.runtime.id, chrome.runtime.getURL('popup.html'))) return false;
  void (async () => {const workerStarted=performance.now(); try {
    const message = popupRequest.parse(raw);const correlationId=(message as {correlationId?:string}).correlationId;const started=performance.now();if(correlationId)accessDiagnostics.event(correlationId,'worker_handler_entered','START');
    const current=await resolvePopupActiveTab((message as {windowId:number}).windowId,windowId=>chrome.tabs.query({active:true,windowId}));
    if (message.action === 'approve') await controller.approve(message.id as string, (message as {origin:string}).origin, (message as {always:boolean}).always,correlationId,current);
    if(message.action==='selectAccessTab')await controller.selectAccessTab(message.id as string,(message as {candidateId:string}).candidateId);
    const selectionApplied=message.action==='selectConversation' ? await controller.selectConversation(message.id as string,current) : false;
    if(message.action==='selectConversation'&&!selectionApplied)throw new Error('REJECTED');
    if(message.action==='cancelManualSelection')controller.cancelManualSelection(message.id as string);
    if (message.action === 'revokeSite') await sites.revoke((message as {origin:string}).origin);
    if (message.action === 'revoke') await controller.revoke(message.id as string);
    if (message.action === 'renew') await controller.renew(message.id as string,current);
    if (message.action === 'deny') controller.deny(message.id as string, true);
    await badge(); const currentOrigin = current.url && /^https?:/.test(current.url) ? new URL(current.url).origin : 'Página no soportada'; const response={ currentOrigin, connected: !!port && !!controller.epoch, selectionApplied, pending: await controller.preparePending(current), authorized: controller.authorized(), sites: await sites.list() };if(correlationId)accessDiagnostics.event(correlationId,'state_ready','OK',performance.now()-started);send(response);
  } catch (error) {if(typeof raw?.correlationId==='string')accessDiagnostics.event(raw.correlationId,'state_ready','FAILED',performance.now()-workerStarted); send({ error: error instanceof Error && activeTabErrors.includes(error.message as typeof activeTabErrors[number]) ? error.message : 'No se pudo completar el cambio de acceso. Revisá la pestaña, el permiso de Chrome y los sitios permitidos; no se asumió aprobación.' }); } })(); return true;
});
chrome.tabs.onRemoved.addListener(id => { for (const grant of controller.grants.values()) if (grant.chromeId === id) void controller.revoke(grant.scopeId).then(badge); });
chrome.tabs.onActivated.addListener(info=>{void controller.activeTabChanged(info.tabId,info.windowId).then(badge);});
chrome.tabs.onUpdated.addListener((id, change) => { if (change.status === 'loading') void controller.documentChanged(id); });
setInterval(() => { controller.expire(); void badge(); }, 10_000);
connect();

chrome.permissions.onRemoved.addListener(() => { void sites.reconcile().then(badge).catch(() => {}); });
chrome.permissions.onAdded.addListener(() => { void sites.reconcile().then(badge).catch(() => {}); });
void sites.reconcile().catch(() => {});
