const state = document.getElementById('state')!;
const pending = document.getElementById('pending')!;
const authorized = document.getElementById('authorized')!;
async function command(action: string, id?: string) {
  try { const reply = await chrome.runtime.sendMessage({ action, ...(id ? { id } : {}) }); if (reply.error) { state.textContent = reply.error; return; }
    state.textContent = reply.connected ? 'Conectado a Atlas' : 'Atlas no está conectado. Iniciá Atlas en modo attached.';
    pending.replaceChildren(); authorized.replaceChildren();
    for (const request of reply.pending) {
      const row = document.createElement('div'); const text = document.createElement('p'); text.textContent = `Permitir que Atlas controle la pestaña actual (${reply.currentOrigin}): ${request.purpose}. ${request.lifetime === 'session' ? 'Esta sesión (30 min)' : 'Esta tarea (15 min)'}. No autoriza acciones consecuenciales.`; row.append(text);
      button(row, 'Permitir pestaña actual', () => command('approve', request.id)); button(row, 'Cancelar', () => command('deny', request.id)); pending.append(row);
    }
    for (const tab of reply.authorized) { const row = document.createElement('div'); const text = document.createElement('p'); text.textContent = `${tab.title || 'Pestaña autorizada'} · ${tab.url} · ${tab.state}`; row.append(text); button(row, 'Revocar', () => command('revoke', tab.scopeId)); button(row, 'Renovar origen (seleccioná esta pestaña)', () => command('renew', tab.scopeId)); authorized.append(row); }
  } catch { state.textContent = 'Bridge no disponible.'; }
}
function button(row: HTMLElement, text: string, action: () => Promise<void>) { const button = document.createElement('button'); button.textContent = text; button.onclick = () => { void action(); }; row.append(button); }
void command('state');
