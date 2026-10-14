import { contextBridge, ipcRenderer } from 'electron';
import type { AtlasDesktopApi } from './api.js';

const api: AtlasDesktopApi = {
  core: {
    request: (requestId, operation, input, options) => ipcRenderer.invoke('atlas:core-request', requestId, operation, input, options),
    cancel: requestId => { ipcRenderer.send('atlas:core-cancel', requestId); }
  },
  realtime: { token: () => ipcRenderer.invoke('atlas:realtime-token') },
  lifecycle: {
    onShutdown(listener) { const wrapped = () => listener(); ipcRenderer.on('atlas:shutdown', wrapped); return () => ipcRenderer.removeListener('atlas:shutdown', wrapped); },
    ready() { ipcRenderer.send('atlas:shutdown-ready'); }
  }
};
contextBridge.exposeInMainWorld('atlasDesktop', api);
