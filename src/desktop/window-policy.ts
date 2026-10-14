export function secureWindowOptions(preload: string) {
  return {
    width: 920, height: 760, minWidth: 640, minHeight: 600, show: false,
    backgroundColor: '#05070a',
    webPreferences: { preload, nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, allowRunningInsecureContent: false }
  } as const;
}

export function sameApplicationLocation(candidate: string, applicationOrigin: string): boolean {
  try { const url = new URL(candidate); return url.origin === applicationOrigin && (url.protocol === 'http:' || url.protocol === 'https:'); }
  catch { return false; }
}

export function audioPermissionAllowed(permission: string, requestingUrl: string, mediaTypes: string[] | undefined, applicationOrigin: string): boolean {
  return permission === 'media' && sameApplicationLocation(requestingUrl, applicationOrigin) && !!mediaTypes?.length && mediaTypes.every(type => type === 'audio');
}
