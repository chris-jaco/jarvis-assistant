import type { AtlasCredentialSetupApi, CredentialSetupResult } from '../credential-setup-api.js';

declare global { interface Window { atlasCredentialSetup?: AtlasCredentialSetupApi } }

export function mountCredentialSetup(document: Document, api: AtlasCredentialSetupApi, closeWindow: () => void): () => void {
  const form = document.querySelector<HTMLFormElement>('#credential-form')!;
  const input = document.querySelector<HTMLInputElement>('#api-key')!;
  const status = document.querySelector<HTMLElement>('#status')!;
  const clear = document.querySelector<HTMLButtonElement>('#clear')!;
  const remove = document.querySelector<HTMLButtonElement>('#delete')!;
  const proceed = document.querySelector<HTMLButtonElement>('#continue')!;
  const save = document.querySelector<HTMLButtonElement>('#save')!;
  let configured = false; let busy = false;

  const render = (result: CredentialSetupResult) => {
    configured = result.ok && result.state === 'CONFIGURED';
    const suffix = result.ok ? '' : ` — ${result.error}`;
    status.textContent = `${result.state}${suffix}`;
    proceed.hidden = !configured;
    remove.disabled = !configured || busy;
    save.disabled = busy;
  };
  const run = async (operation: () => Promise<CredentialSetupResult>) => {
    if (busy) return;
    busy = true; save.disabled = true; remove.disabled = true;
    try { render(await operation()); }
    catch { render({ ok: false, state: 'INVALID', error: 'OPERATION_FAILED' }); }
    finally { busy = false; input.value = ''; save.disabled = false; remove.disabled = !configured; }
  };
  const submit = (event: Event) => { event.preventDefault(); const value = input.value; void run(() => api.provisionOpenAI(value)); };
  const clearInput = () => { input.value = ''; input.focus(); };
  const deleteCredential = () => { if (globalThis.confirm('¿Eliminar la API key almacenada?')) void run(() => api.deleteOpenAI()); };
  const continueToAtlas = () => { if (configured && !busy) closeWindow(); };
  form.addEventListener('submit', submit);
  clear.addEventListener('click', clearInput);
  remove.addEventListener('click', deleteCredential);
  proceed.addEventListener('click', continueToAtlas);
  void run(() => api.status());
  return () => {
    input.value = '';
    form.removeEventListener('submit', submit);
    clear.removeEventListener('click', clearInput);
    remove.removeEventListener('click', deleteCredential);
    proceed.removeEventListener('click', continueToAtlas);
  };
}

if (typeof window !== 'undefined' && window.atlasCredentialSetup) mountCredentialSetup(document, window.atlasCredentialSetup, () => window.close());
