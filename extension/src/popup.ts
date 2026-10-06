import { PopupDiagnostics } from '../../src/diagnostics/popup.js';
const accessDiagnostics=new PopupDiagnostics();
const opened=performance.now();const openedId=crypto.randomUUID();
void chrome.storage?.local?.get('atlasPopupDiagnostics').then(value=>{accessDiagnostics.enabled=value.atlasPopupDiagnostics===true;accessDiagnostics.event(openedId,'popup_opened','OK',performance.now()-opened);accessDiagnostics.event(openedId,'state_requested','START');}).catch(()=>{});
let closed=false;let requestSequence=0;
addEventListener('pagehide',()=>{closed=true;});
import { hostPattern } from './site-authorization.js';
const state = document.getElementById('state')!;
const pending = document.getElementById('pending')!;
const authorized = document.getElementById('authorized')!;
const sites = document.getElementById('sites')!;
async function command(action: string, fields: Record<string,unknown> = {}, correlationId=crypto.randomUUID()) {
  const sequence=++requestSequence;const started=performance.now();accessDiagnostics.event(correlationId,'state_requested','START');
  try {
    const reply = await chrome.runtime.sendMessage({ action, ...fields,correlationId });
    accessDiagnostics.event(correlationId,'state_ready',closed?'CLOSED':sequence!==requestSequence?'OUT_OF_ORDER':reply.error?'FAILED':'OK',performance.now()-started);if(closed||sequence!==requestSequence)return;
    if (reply.error) { state.textContent = reply.error; return; }
    state.textContent = reply.connected ? 'Conectado a Atlas' : 'Atlas no está conectado. Iniciá Atlas en modo attached.';
    pending.replaceChildren(); authorized.replaceChildren(); sites.replaceChildren();
    for (const request of reply.pending) {
      const row = document.createElement('div'); const text = document.createElement('p');
      text.textContent = `Atlas quiere acceder a ${request.origin ?? 'la pestaña solicitada'}: ${request.purpose}. ${request.lifetime === 'session' ? 'Esta sesión (30 min)' : 'Esta tarea (15 min)'}. No autoriza acciones sensibles.`; row.append(text);
      if (request.tabSelected && request.origin) {
        button(row, 'Permitir esta vez', () => {const correlation=crypto.randomUUID();accessDiagnostics.event(correlation,'authorization_click','START');accessDiagnostics.event(correlation,'permission_result','NOT_APPLICABLE');return command('approve', {id:request.id,origin:request.origin,always:false},correlation);});
        if (request.origin.startsWith('https://')) button(row, 'Permitir siempre este sitio', () => {
          // Call directly from the click, before any await/message, to preserve
          // Chrome's real user gesture. No backend can trigger this request.
          const correlation=crypto.randomUUID();const permissionStarted=performance.now();accessDiagnostics.event(correlation,'authorization_click','START');
          const requested = chrome.permissions.request({origins:[hostPattern(request.origin)]});
          return requested.then(allowed => {accessDiagnostics.event(correlation,'permission_result',allowed?'OK':'DENIED',performance.now()-permissionStarted);return allowed?command('approve',{id:request.id,origin:request.origin,always:true},correlation):command('state');}).catch(() => { accessDiagnostics.event(correlation,'permission_result','FAILED',performance.now()-permissionStarted);state.textContent='Chrome no concedió el permiso. No se guardó autorización.'; });
        });
      } else { const hint=document.createElement('p');hint.textContent='Seleccioná la pestaña solicitada y abrí nuevamente este popup.';row.append(hint); }
      button(row, 'Cancelar', () => command('deny', {id:request.id})); pending.append(row);
    }
    for (const tab of reply.authorized) {
      const row=document.createElement('div');const text=document.createElement('p');text.textContent=`${tab.title || 'Pestaña autorizada'} · ${tab.url} · ${tab.state}`;row.append(text);
      button(row,'Revocar pestaña',()=>command('revoke',{id:tab.scopeId}));authorized.append(row);
    }
    for (const site of reply.sites) {
      const row=document.createElement('div');const text=document.createElement('p');text.textContent=`${site.origin} · ${site.allowed ? 'ALLOW' : 'Bloqueado'}`;row.append(text);
      button(row,'Revocar',()=>command('revokeSite',{origin:site.origin}));sites.append(row);
    }
    if (!reply.sites.length) sites.textContent='Ningún sitio permitido permanentemente.';
  } catch {accessDiagnostics.event(correlationId,'state_ready','FAILED',performance.now()-started);if(closed)return; state.textContent='Bridge o preferencias no disponibles. No se asumió autorización.'; }
}
function button(row: HTMLElement, text: string, action: () => Promise<void>) { const button=document.createElement('button');button.textContent=text;button.onclick=()=>{void action();};row.append(button); }
chrome.permissions.onRemoved.addListener(()=>{void command('state');});
chrome.permissions.onAdded.addListener(()=>{void command('state');});
void command('state',{},openedId);
