import { app, BrowserWindow, dialog, ipcMain, session, utilityProcess } from 'electron';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BackendSupervisor } from './backend-supervisor.js';
import { registerDesktopIpc } from './ipc.js';
import { audioPermissionAllowed, sameApplicationLocation, secureWindowOptions } from './window-policy.js';
import { acquireSingleInstance, focusExistingWindow } from './lifecycle.js';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '../../..');
const serverEntry = resolve(projectRoot, 'dist/server/server/index.js');
const preload = resolve(projectRoot, 'dist/desktop-preload/preload.cjs');
let window: BrowserWindow | undefined;
let cleanupIpc: (() => void) | undefined;
let closing = false;
let rendererShutdownReady: (() => void) | undefined;

const supervisor = new BackendSupervisor({
  executable: process.execPath, serverEntry, cwd: projectRoot,
  spawn: (_executable, args, options) => utilityProcess.fork(args[0]!, [], { cwd: options.cwd, env: options.env, stdio: 'pipe', serviceName: 'Atlas Core' }) as unknown as import('./backend-supervisor.js').BackendProcess,
  onUnexpectedExit: () => {
    if (closing) return;
    void dialog.showMessageBox({ type: 'error', title: 'Atlas Core se detuvo', message: 'Atlas Core se cerró inesperadamente. Cerrá y volvé a abrir Atlas.' });
    void shutdown();
  }
});

async function requestRendererCleanup(): Promise<void> {
  const current = window; if (!current || current.isDestroyed()) return;
  await Promise.race([
    new Promise<void>(resolveReady => { rendererShutdownReady = resolveReady; current.webContents.send('atlas:shutdown'); }),
    new Promise<void>(resolveTimeout => setTimeout(resolveTimeout, 750))
  ]);
  rendererShutdownReady = undefined;
}

async function shutdown(): Promise<void> {
  if (closing) return; closing = true;
  await requestRendererCleanup(); cleanupIpc?.(); cleanupIpc = undefined;
  await supervisor.stop();
  if (window && !window.isDestroyed()) window.destroy(); window = undefined;
  app.quit();
}

async function start(): Promise<void> {
  const endpoint = await supervisor.start();
  const applicationOrigin = new URL(endpoint.baseUrl).origin;
  const browserWindow = new BrowserWindow(secureWindowOptions(preload)); window = browserWindow;
  cleanupIpc = registerDesktopIpc(ipcMain, supervisor.backendClient(), senderId => browserWindow.webContents.id === senderId && !browserWindow.isDestroyed());
  ipcMain.on('atlas:shutdown-ready', event => { if (event.sender.id === browserWindow.webContents.id) rendererShutdownReady?.(); });
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const mediaTypes = 'mediaTypes' in details ? details.mediaTypes : undefined;
    callback(webContents.id === browserWindow.webContents.id && audioPermissionAllowed(permission, details.requestingUrl, mediaTypes, applicationOrigin));
  });
  session.defaultSession.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) =>
    !!webContents && webContents.id === browserWindow.webContents.id && audioPermissionAllowed(permission, requestingOrigin, details.mediaType ? [details.mediaType] : undefined, applicationOrigin));
  browserWindow.webContents.on('will-navigate', (event, url) => { if (!sameApplicationLocation(url, applicationOrigin)) event.preventDefault(); });
  browserWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  browserWindow.once('ready-to-show', () => browserWindow.show());
  browserWindow.on('close', event => { if (!closing) { event.preventDefault(); void shutdown(); } });
  await browserWindow.loadURL(endpoint.baseUrl);
}

if (!acquireSingleInstance(app)) { /* quit requested by helper */ }
else {
  app.on('second-instance', () => focusExistingWindow(window));
  app.on('window-all-closed', () => { void shutdown(); });
  app.on('before-quit', event => { if (!closing) { event.preventDefault(); void shutdown(); } });
  app.whenReady().then(start).catch(error => {
    console.error('ATLAS_DESKTOP_START_FAILED');
    dialog.showErrorBox('Atlas no pudo iniciar', error instanceof Error && error.message.startsWith('DESKTOP_') ? error.message : 'No se pudo iniciar Atlas Desktop.');
    void shutdown();
  });
}
