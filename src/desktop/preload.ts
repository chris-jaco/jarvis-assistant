import { contextBridge, ipcRenderer } from 'electron';
import type { AtlasDesktopApi } from './api.js';
import { DESKTOP_CLEANUP_REQUEST_CHANNEL, DESKTOP_CLEANUP_RESULT_CHANNEL, validDesktopCleanupRequest, validDesktopCleanupResult } from './cleanup-protocol.js';

const api: AtlasDesktopApi = {
  core: {
    request: (requestId, operation, input, options) => ipcRenderer.invoke('atlas:core-request', requestId, operation, input, options),
    cancel: requestId => { ipcRenderer.send('atlas:core-cancel', requestId); }
  },
  realtime: { token: () => ipcRenderer.invoke('atlas:realtime-token') },
  lifecycle: {
    onShutdown(listener) { const wrapped = () => listener(); ipcRenderer.on('atlas:shutdown', wrapped); return () => ipcRenderer.removeListener('atlas:shutdown', wrapped); },
    ready() { ipcRenderer.send('atlas:shutdown-ready'); },
    onCleanup(listener) {
      const wrapped = (_event: unknown, request: unknown) => { if (validDesktopCleanupRequest(request)) listener(request); };
      ipcRenderer.on(DESKTOP_CLEANUP_REQUEST_CHANNEL, wrapped);
      return () => ipcRenderer.removeListener(DESKTOP_CLEANUP_REQUEST_CHANNEL, wrapped);
    },
    completeCleanup(result) { if (validDesktopCleanupResult(result)) ipcRenderer.send(DESKTOP_CLEANUP_RESULT_CHANNEL, result); }
  }
};
contextBridge.exposeInMainWorld('atlasDesktop', api);
