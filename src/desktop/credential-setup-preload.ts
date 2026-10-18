import { contextBridge, ipcRenderer } from 'electron';
import type { AtlasCredentialSetupApi } from './credential-setup-api.js';
import {
  CREDENTIAL_DELETE_OPENAI_CHANNEL,
  CREDENTIAL_CONTINUE_CHANNEL,
  CREDENTIAL_PROVISION_OPENAI_CHANNEL,
  CREDENTIAL_STATUS_CHANNEL
} from './credential-setup-api.js';

const api: AtlasCredentialSetupApi = {
  status: () => ipcRenderer.invoke(CREDENTIAL_STATUS_CHANNEL),
  provisionOpenAI: value => ipcRenderer.invoke(CREDENTIAL_PROVISION_OPENAI_CHANNEL, value),
  deleteOpenAI: () => ipcRenderer.invoke(CREDENTIAL_DELETE_OPENAI_CHANNEL),
  continueToAtlas: () => ipcRenderer.invoke(CREDENTIAL_CONTINUE_CHANNEL)
};
contextBridge.exposeInMainWorld('atlasCredentialSetup', api);
