import { dialog, shell } from 'electron';
import { GmailAccountStore } from '../tools/adapters/gmail-accounts.js';
import { GoogleAuth, disconnectCalendarLocally, googleConfig, readTokens } from '../tools/adapters/google-auth.js';
import { authorizeGoogle, checkGoogleConnection, type GoogleService } from '../server/google-onboarding.js';
import { importGoogleClient } from './google-client-import.js';
import type { DesktopCredentialStore } from './credential-store.js';
import type { DesktopRuntimePaths } from './runtime-paths.js';

function choose(message: string, buttons: string[], detail?: string) {
  return dialog.showMessageBox({ title: 'Atlas · Google', message, detail, buttons, defaultId: buttons.length - 1,
    cancelId: buttons.length - 1, noLink: true }).then(result => result.response);
}
async function selectAccount(store: GmailAccountStore) {
  const accounts = await store.list();
  if (!accounts.length) { await choose('Todavía no hay cuentas de Gmail conectadas.', ['Volver']); return; }
  for (const account of accounts) {
    const buttons = ['Elegir esta cuenta', 'Siguiente', 'Volver'];
    const choice = await choose(account.email, buttons);
    if (choice === 0) return account;
    if (choice !== 1) return;
  }
}

/** Runs with Core stopped. A refresh in another Atlas process cannot resurrect
 * credentials after removal. Only the system browser receives the consent URL. */
export async function manageGoogle(store: DesktopCredentialStore, paths: DesktopRuntimePaths, signal: AbortSignal) {
  while (!signal.aborted) {
    const action = 1 + await choose('Gmail y Google Calendar', [
      'Importar cliente OAuth', 'Conectar', 'Verificar conexión', 'Desconectar', 'Continuar a Atlas'
    ], 'El cliente OAuth identifica a Atlas. Cada servicio necesita además autorización de tu cuenta de Google.');
    if (action === 5 || signal.aborted) return;
    try {
      if (action === 1) {
        const result = await importGoogleClient(async () => {
          const selection = await dialog.showOpenDialog({ title: 'Elegí el JSON de cliente OAuth de tipo Escritorio',
            properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }] });
          return selection.canceled ? undefined : selection.filePaths[0];
        }, pair => store.setGoogleClient(pair));
        if (result === 'IMPORTED') await choose('Cliente OAuth guardado con cifrado de Windows.', ['Volver']);
        continue;
      }
      const target = await choose('Elegí la integración', ['Gmail', 'Calendar', 'Volver']);
      if (target > 1 || signal.aborted) continue;
      const service: GoogleService = target === 0 ? 'gmail' : 'calendar';
      // No inherited env values, file-provided endpoints or renderer-selected paths.
      const local = { GMAIL_ACCOUNTS_PATH: paths.gmailAccountsPath, GOOGLE_TOKEN_PATH: paths.googleTokenPath };
      if (action === 4) {
        const accounts = new GmailAccountStore(local);
        const account = service === 'gmail' ? await selectAccount(accounts) : undefined;
        if (service === 'gmail' && !account) continue;
        if (await choose('¿Desconectar ' + (account?.email ?? 'Calendar') + ' de este Atlas?', ['Desconectar', 'Volver'],
            'Se quitará el token local. El permiso remoto se gestiona en tu cuenta Google.') !== 0) continue;
        if (account) await accounts.remove(account.id);
        else await disconnectCalendarLocally(paths.googleTokenPath);
        await choose('Autorización local eliminada. El permiso remoto sigue bajo tu control en Google.', ['Volver']);
        continue;
      }
      await store.withGoogleClient(async pair => {
        if (!pair) { await choose('Primero importá el archivo de cliente OAuth de escritorio.', ['Volver']); return; }
        const env = { ...local, ...pair };
        if (action === 2) {
          const cancel = new AbortController();
          const dismiss = new AbortController();
          try {
            await authorizeGoogle({ service, env, signal: AbortSignal.any([signal, cancel.signal]),
              openBrowser: async url => {
                await shell.openExternal(url);
                if (signal.aborted || dismiss.signal.aborted) return;
                void dialog.showMessageBox({ title: 'Conectar Google', message: 'Completá la autorización en tu navegador.',
                  buttons: ['Cancelar'], cancelId: 0, signal: dismiss.signal }).then(() => {
                    if (!dismiss.signal.aborted) cancel.abort();
                  }, () => cancel.abort());
              }
            });
          } finally { dismiss.abort(); }
          if (!signal.aborted) await choose('Autorización de Google completada.', ['Volver']);
          return;
        }
        const accounts = new GmailAccountStore(env);
        const account = service === 'gmail' ? await selectAccount(accounts) : undefined;
        if (service === 'gmail' && !account) return;
        if (service === 'calendar') {
          try { await readTokens(paths.googleTokenPath); }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            await choose('Todavía no hay una autorización local de Calendar.', ['Volver']);
            return;
          }
        }
        const state = await checkGoogleConnection(service, pair.GOOGLE_CLIENT_ID, account
          ? () => accounts.token(account.id) : () => new GoogleAuth(googleConfig(env)).token());
        const messages = {
          VERIFIED: 'Google verificó el token y los permisos para esta integración.',
          REAUTHORIZE: 'El token perdió vigencia o permisos. Volvé a conectar esta integración.',
          UNVERIFIED: 'No se pudo verificar. Revisá la conexión o volvé a autorizar la cuenta.'
        };
        if (!signal.aborted) await choose(messages[state], ['Volver']);
      });
    } catch {
      if (!signal.aborted) await choose('La operación no se completó.', ['Volver'],
        'Revisá el tipo de archivo, la protección del almacenamiento, la conexión y los permisos de la cuenta.');
    }
  }
}
