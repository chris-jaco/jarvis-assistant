import { BrowserWindow, ipcMain, session } from 'electron';
import { pathToFileURL } from 'node:url';
import type { DesktopCredentialStore } from './credential-store.js';
import { registerCredentialSetupIpc } from './credential-setup-ipc.js';

export interface CredentialSetupWindowPaths {
  html: string;
  preload: string;
  icon: string;
}

export async function runCredentialSetupWindow(
  store: DesktopCredentialStore,
  paths: CredentialSetupWindowPaths,
  observeWindow?: (window: BrowserWindow | undefined) => void
): Promise<boolean> {
  const isolatedSession = session.fromPartition('atlas-credential-setup', { cache: false });
  isolatedSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  isolatedSession.setPermissionCheckHandler(() => false);
  const setupWindow = new BrowserWindow({
    width: 620, height: 560, minWidth: 520, minHeight: 500, show: false,
    title: 'Configurar Atlas', backgroundColor: '#10121F', icon: paths.icon,
    webPreferences: {
      preload: paths.preload, nodeIntegration: false, contextIsolation: true,
      sandbox: true, webSecurity: true, allowRunningInsecureContent: false, devTools: false,
      partition: 'atlas-credential-setup'
    }
  });
  observeWindow?.(setupWindow);
  const expected = pathToFileURL(paths.html).href;
  const ipc = registerCredentialSetupIpc(ipcMain, store, senderId => !setupWindow.isDestroyed() && setupWindow.webContents.id === senderId);
  setupWindow.webContents.on('will-navigate', (event, url) => { if (url !== expected) event.preventDefault(); });
  setupWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  setupWindow.once('ready-to-show', () => setupWindow.show());
  return new Promise<boolean>((resolve, reject) => {
    let loaded = false;
    setupWindow.webContents.once('did-finish-load', () => { loaded = true; });
    setupWindow.webContents.once('did-fail-load', (_event, _code, _description) => {
      if (!setupWindow.isDestroyed()) setupWindow.destroy();
      reject(new Error('DESKTOP_CREDENTIAL_SETUP_LOAD_FAILED'));
    });
    setupWindow.once('closed', () => {
      ipc.dispose(); observeWindow?.(undefined);
      if (!loaded) { resolve(false); return; }
      void store.status().then(status => resolve(status.OPENAI_API_KEY === 'CONFIGURED'), () => resolve(false));
    });
    void setupWindow.loadFile(paths.html).catch(() => {
      if (!setupWindow.isDestroyed()) setupWindow.destroy();
    });
  });
}
