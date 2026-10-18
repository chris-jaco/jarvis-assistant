import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export type DesktopRuntimeMode = 'DEVELOPMENT' | 'PACKAGED';

export interface DesktopPathInputs {
  packaged: boolean;
  mainModulePath: string;
  appPath: string;
  resourcesPath: string;
  userDataPath: string;
}

export interface DesktopRuntimePaths {
  mode: DesktopRuntimeMode;
  applicationRoot: string;
  resourcesRoot: string;
  unpackedResourcesRoot: string;
  mainEntry: string;
  preloadEntry: string;
  credentialSetupPreloadEntry: string;
  credentialSetupHtml: string;
  coreEntry: string;
  rendererRoot: string;
  assetsRoot: string;
  trayIcon: string;
  applicationIcon: string;
  dataRoot: string;
  coreWorkingDirectory: string;
  configRoot: string;
  configFile: string;
  localDataRoot: string;
  memoryPath: string;
  credentialsRoot: string;
  googleTokenPath: string;
  gmailAccountsPath: string;
  journalPath: string;
  logsRoot: string;
  cacheRoot: string;
}

function inside(parent: string, candidate: string): boolean {
  const value = relative(resolve(parent), resolve(candidate));
  return value === '' || (!value.startsWith(`..${sep}`) && value !== '..' && !isAbsolute(value));
}

function absolute(name: string, value: string): string {
  if (!isAbsolute(value)) throw new Error(`DESKTOP_PATH_${name}_NOT_ABSOLUTE`);
  return resolve(value);
}

export function resolveDesktopRuntimePaths(input: DesktopPathInputs): DesktopRuntimePaths {
  const appPath = absolute('APP', input.appPath);
  const resourcesPath = absolute('RESOURCES', input.resourcesPath);
  const mainEntry = absolute('MAIN', input.mainModulePath);
  const developmentRoot = resolve(dirname(mainEntry), '../../..');
  const applicationRoot = input.packaged ? appPath : developmentRoot;
  const dataRoot = input.packaged ? absolute('USER_DATA', input.userDataPath) : applicationRoot;

  if (input.packaged && (inside(applicationRoot, dataRoot) || inside(resourcesPath, dataRoot))) {
    throw new Error('DESKTOP_PATH_DATA_INSIDE_APPLICATION');
  }

  const localDataRoot = join(dataRoot, '.local');
  const assetsRoot = join(applicationRoot, 'public', 'brand');
  return {
    mode: input.packaged ? 'PACKAGED' : 'DEVELOPMENT',
    applicationRoot,
    resourcesRoot: resourcesPath,
    unpackedResourcesRoot: join(resourcesPath, 'app.asar.unpacked'),
    mainEntry,
    preloadEntry: join(applicationRoot, 'dist', 'desktop-preload', 'preload.cjs'),
    credentialSetupPreloadEntry: join(applicationRoot, 'dist', 'desktop-credential-setup', 'preload.cjs'),
    credentialSetupHtml: join(applicationRoot, 'dist', 'desktop-credential-setup', 'index.html'),
    coreEntry: join(applicationRoot, 'dist', 'server', 'server', 'index.js'),
    rendererRoot: join(applicationRoot, 'dist', 'client'),
    assetsRoot,
    trayIcon: join(assetsRoot, 'atlas-tray.ico'),
    applicationIcon: join(assetsRoot, 'atlas-app.ico'),
    dataRoot,
    coreWorkingDirectory: dataRoot,
    configRoot: join(dataRoot, 'config'),
    configFile: join(dataRoot, 'config', 'atlas.env'),
    localDataRoot,
    memoryPath: join(localDataRoot, 'memory', 'memories.json'),
    credentialsRoot: join(dataRoot, 'credentials'),
    googleTokenPath: join(localDataRoot, 'google-tokens.json'),
    gmailAccountsPath: join(localDataRoot, 'gmail-accounts'),
    journalPath: join(localDataRoot, 'browser-consequential', 'journal.json'),
    logsRoot: join(dataRoot, 'logs'),
    cacheRoot: join(dataRoot, 'cache')
  };
}

