import { hostPattern } from './site-authorization.js';
const state = document.getElementById('state')!;
const pending = document.getElementById('pending')!;
const authorized = document.getElementById('authorized')!;
const sites = document.getElementById('sites')!;
async function command(action: string, fields: Record<string,unknown> = {}) {
  try {
    const reply = await chrome.runtime.sendMessage({ action, ...fields });
    if (reply.error) { state.textContent = reply.error; return; }
    state.textContent = reply.connected ? 'Conectado a Atlas' : 'Atlas no está conectado. Iniciá Atlas en modo attached.';
    pending.replaceChildren(); authorized.replaceChildren(); sites.replaceChildren();
    for (const request of reply.pending) {
      const row = document.createElement('div'); const text = document.createElement('p');
      text.textContent = `Atlas quiere acceder a ${request.origin ?? 'la pestaña solicitada'}: ${request.purpose}. ${request.lifetime === 'session' ? 'Esta sesión (30 min)' : 'Esta tarea (15 min)'}. No autoriza acciones sensibles.`; row.append(text);
      if (request.tabSelected && request.origin) {
        button(row, 'Permitir esta vez', () => command('approve', {id:request.id,origin:request.origin,always:false}));
        if (request.origin.startsWith('https://')) button(row, 'Permitir siempre este sitio', () => {
          // Call directly from the click, before any await/message, to preserve
          // Chrome's real user gesture. No backend can trigger this request.
          const requested = chrome.permissions.request({origins:[hostPattern(request.origin)]});
          return requested.then(allowed => allowed ? command('approve',{id:request.id,origin:request.origin,always:true}) : command('state')).catch(() => { state.textContent='Chrome no concedió el permiso. No se guardó autorización.'; });
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
  } catch { state.textContent='Bridge o preferencias no disponibles. No se asumió autorización.'; }
}
function button(row: HTMLElement, text: string, action: () => Promise<void>) { const button=document.createElement('button');button.textContent=text;button.onclick=()=>{void action();};row.append(button); }
chrome.permissions.onRemoved.addListener(()=>{void command('state');});
chrome.permissions.onAdded.addListener(()=>{void command('state');});
void command('state');
