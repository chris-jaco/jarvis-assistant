import { app, BrowserWindow, dialog, ipcMain, Menu, session, utilityProcess } from 'electron';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BackendSupervisor } from './backend-supervisor.js';
import { registerDesktopIpc } from './ipc.js';
import type { DesktopIpcController } from './ipc.js';
import { DesktopCleanupProtocol } from './cleanup-protocol.js';
import { DesktopLifecycleRuntime } from './lifecycle-runtime.js';
import { createElectronTrayController } from './electron-tray.js';
import type { DesktopTrayController } from './tray-controller.js';
import { desktopApplicationMenu, registerDesktopWindowControls, requestSafeDesktopHide } from './window-controls.js';
import { audioPermissionAllowed, sameApplicationLocation, secureWindowOptions } from './window-policy.js';
import { acquireSingleInstance, focusExistingWindow } from './lifecycle.js';
import { resolveDesktopRuntimePaths } from './runtime-paths.js';
import { desktopCoreEnvironment } from './core-environment.js';
import { createElectronDesktopCredentialStore } from './electron-credential-store.js';
import { runCredentialSetupWindow } from './credential-setup-window.js';
import { randomUUID } from 'node:crypto';
import { CredentialSetupPreference, requestCredentialReconfiguration, shouldShowCredentialSetup } from './credential-lifecycle.js';

let window: BrowserWindow | undefined;
let cleanupIpc: DesktopIpcController | undefined;
let cleanupProtocol: DesktopCleanupProtocol | undefined;
let lifecycle: DesktopLifecycleRuntime | undefined;
let trayController: DesktopTrayController | undefined;
let closing = false;
let trayWarning: Promise<void> | undefined;
let supervisor: BackendSupervisor | undefined;

async function startupShutdown(message?: Electron.MessageBoxOptions): Promise<void> {
  if (closing) return; closing = true;
  disposeTray();
  cleanupProtocol?.dispose();cleanupProtocol=undefined;cleanupIpc?.dispose();cleanupIpc=undefined;
  await supervisor?.stop();
  if (message) await dialog.showMessageBox(message);
  if (window && !window.isDestroyed()) window.destroy(); window = undefined;
  app.quit();
}

function disposeTray():void{
  trayController?.dispose();
  trayController=undefined;
}

function requestQuit():Promise<void>|undefined{
  disposeTray();
  return lifecycle?.quit();
}

function showTrayUnavailable(browserWindow:BrowserWindow):Promise<void>{
  if(trayWarning)return trayWarning;
  const warning=dialog.showMessageBox(browserWindow,{type:'warning',title:'Atlas seguirá visible',message:'Atlas no pudo iniciar el icono del área de notificación. La ventana seguirá visible para evitar que pierdas acceso; usá “Salir de Atlas” para cerrar la aplicación.'}).then(()=>undefined);
  const tracked=warning.finally(()=>{if(trayWarning===tracked)trayWarning=undefined;});
  trayWarning=tracked;
  return tracked;
}

async function start(): Promise<void> {
  const paths = resolveDesktopRuntimePaths({
    packaged: app.isPackaged,
    mainModulePath: fileURLToPath(import.meta.url),
    appPath: app.getAppPath(),
    resourcesPath: process.resourcesPath,
    userDataPath: app.getPath('userData')
  });
  await mkdir(paths.coreWorkingDirectory, { recursive: true });
  let credentialStore: ReturnType<typeof createElectronDesktopCredentialStore> | undefined;
  let credentialPreference: CredentialSetupPreference | undefined;
  if (paths.mode === 'PACKAGED') {
    Menu.setApplicationMenu(null);
    credentialStore = createElectronDesktopCredentialStore(paths.credentialsRoot);
    credentialPreference = new CredentialSetupPreference(paths.configRoot);
    const state = (await credentialStore.status()).OPENAI_API_KEY;
    if (shouldShowCredentialSetup(state, await credentialPreference.required())) {
      const configured = await runCredentialSetupWindow(credentialStore, {
        html: paths.credentialSetupHtml,
        preload: paths.credentialSetupPreloadEntry,
        icon: paths.applicationIcon
      }, setupWindow => { window = setupWindow; });
      if (!configured || closing) { closing = true; app.quit(); return; }
      await credentialPreference.clear();
      if (closing) return;
    }
  }
  if (paths.mode === 'DEVELOPMENT') {
    try { process.loadEnvFile(join(paths.coreWorkingDirectory, '.env')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  supervisor = new BackendSupervisor({
    executable: process.execPath,
    serverEntry: paths.coreEntry,
    cwd: paths.coreWorkingDirectory,
    environment: desktopCoreEnvironment(process.env, paths),
    runtime: 'utility',
    spawn: (_executable, args, options) => utilityProcess.fork(args[0]!, [], { cwd: options.cwd, env: options.env, stdio: 'pipe', serviceName: 'Atlas Core' }) as unknown as import('./backend-supervisor.js').BackendProcess,
    onUnexpectedExit: () => {
      if (closing) return;
      disposeTray();
      if(lifecycle)void lifecycle.coreCrash();
      else void startupShutdown({ type: 'error', title: 'Atlas Core se detuvo', message: 'Atlas Core se cerró inesperadamente. Atlas se cerrará de forma segura; volvé a abrirlo para continuar.' });
    }
  });
  const endpoint = credentialStore
    ? await credentialStore.withOpenAIKey(openAIKey => {
        if (closing) throw new Error('DESKTOP_START_CANCELLED');
        return supervisor!.start({ generation: randomUUID(), openAIKey });
      })
    : await supervisor.start();
  const applicationOrigin = new URL(endpoint.baseUrl).origin;
  const browserWindow = new BrowserWindow({ ...secureWindowOptions(paths.preloadEntry), icon: paths.applicationIcon }); window = browserWindow;
  cleanupIpc = registerDesktopIpc(ipcMain, supervisor.backendClient(), senderId => browserWindow.webContents.id === senderId && !browserWindow.isDestroyed());
  cleanupProtocol=new DesktopCleanupProtocol(ipcMain,browserWindow.webContents,senderId=>browserWindow.webContents.id===senderId&&!browserWindow.isDestroyed());
  lifecycle=new DesktopLifecycleRuntime({
    cleanup:cleanupProtocol,ipc:cleanupIpc,
    hideWindow:()=>{if(!browserWindow.isDestroyed())browserWindow.hide();},
    restoreWindow:()=>focusExistingWindow(browserWindow.isDestroyed()?undefined:browserWindow),
    destroyWindow:()=>{closing=true;disposeTray();if(!browserWindow.isDestroyed())browserWindow.destroy();window=undefined;},
    stopCore:()=>supervisor!.stop(),
    showHideFailure:()=>dialog.showMessageBox(browserWindow,{type:'error',title:'Atlas sigue abierto',message:'Atlas no pudo ocultarse de forma segura. La ventana seguirá visible y la voz permanecerá desconectada.'}).then(()=>undefined),
    showCoreCrash:()=>dialog.showMessageBox(browserWindow,{type:'error',title:'Atlas Core se detuvo',message:'Atlas Core se cerró inesperadamente. Atlas se cerrará de forma segura; volvé a abrirlo para continuar.'}).then(()=>undefined),
    quitApplication:()=>{closing=true;app.quit();}
  });
  trayController=createElectronTrayController(paths.trayIcon,{restore:()=>lifecycle?.restore(),quit:()=>requestQuit()});
  trayController.initialize();
  let credentialReconfiguration: Promise<boolean> | undefined;
  const reconfigureCredentials = credentialPreference ? () => {
    if (credentialReconfiguration) return credentialReconfiguration;
    const operation = requestCredentialReconfiguration({
      cleanup: () => lifecycle!.hide(),
      persistPreference: () => credentialPreference!.request(),
      quit: () => lifecycle!.quit(),
      restore: () => { lifecycle?.restore(); },
      showFailure: () => dialog.showMessageBox(browserWindow, { type: 'error', title: 'No se pudo preparar la reconfiguración', message: 'Atlas no pudo cerrar la sesión de forma segura. La credencial no fue modificada y Atlas seguirá visible.' }).then(() => undefined)
    });
    const tracked = operation.finally(() => { if (credentialReconfiguration === tracked) credentialReconfiguration = undefined; });
    credentialReconfiguration = tracked;
    return tracked;
  } : undefined;
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const mediaTypes = 'mediaTypes' in details ? details.mediaTypes : undefined;
    callback(webContents.id === browserWindow.webContents.id && audioPermissionAllowed(permission, details.requestingUrl, mediaTypes, applicationOrigin));
  });
  session.defaultSession.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) =>
    !!webContents && webContents.id === browserWindow.webContents.id && audioPermissionAllowed(permission, requestingOrigin, details.mediaType ? [details.mediaType] : undefined, applicationOrigin));
  browserWindow.webContents.on('will-navigate', (event, url) => { if (!sameApplicationLocation(url, applicationOrigin)) event.preventDefault(); });
  browserWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  browserWindow.once('ready-to-show', () => {lifecycle?.ready();browserWindow.show();});
  registerDesktopWindowControls(browserWindow,{
    hide:()=>closing?false:requestSafeDesktopHide({canHideSafely:()=>trayController?.canHideSafely()??false,hide:()=>lifecycle?.hide()??false,unavailable:()=>showTrayUnavailable(browserWindow)}),
    quit:()=>requestQuit()
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate(desktopApplicationMenu({
    hide:()=>lifecycle?.hide(),
    quit:()=>requestQuit(),
    ...(reconfigureCredentials ? { reconfigureCredentials } : {})
  })));
  await browserWindow.loadURL(endpoint.baseUrl);
}

if (!acquireSingleInstance(app)) { /* quit requested by helper */ }
else {
  app.on('second-instance', () => {if(!lifecycle?.restore())focusExistingWindow(window);});
  app.on('window-all-closed', () => { if(!closing)void lifecycle?.quit(); });
  app.on('before-quit', event => {
    if (closing) return;
    if (!lifecycle) { event.preventDefault(); void startupShutdown(); return; }
    event.preventDefault(); void requestQuit();
  });
  app.whenReady().then(start).catch(error => {
    if (closing) return;
    console.error('ATLAS_DESKTOP_START_FAILED');
    dialog.showErrorBox('Atlas no pudo iniciar', error instanceof Error && error.message.startsWith('DESKTOP_') ? error.message : 'No se pudo iniciar Atlas Desktop.');
    void startupShutdown();
  });
}
