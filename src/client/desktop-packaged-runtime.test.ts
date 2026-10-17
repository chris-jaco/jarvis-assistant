import test from 'node:test';
import assert from 'node:assert/strict';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { allowlistedCoreEnvironment, coreMayLoadDotEnv, desktopCoreEnvironment } from '../desktop/core-environment.js';
import { resolveDesktopRuntimePaths } from '../desktop/runtime-paths.js';

function development() {
  return resolveDesktopRuntimePaths({
    packaged: false,
    mainModulePath: '/checkout/dist/desktop-build/desktop/main.js',
    appPath: '/checkout',
    resourcesPath: '/electron/resources',
    userDataPath: '/users/example/AppData/Roaming/Atlas'
  });
}

function packaged(appPath = '/programs/Atlas/resources/app.asar') {
  return resolveDesktopRuntimePaths({
    packaged: true,
    mainModulePath: `${appPath}/dist/desktop-build/desktop/main.js`,
    appPath,
    resourcesPath: '/programs/Atlas/resources',
    userDataPath: '/users/example/AppData/Roaming/Atlas'
  });
}

function inside(parent: string, child: string): boolean {
  const value = relative(resolve(parent), resolve(child));
  return value === '' || (!value.startsWith(`..${sep}`) && value !== '..' && !isAbsolute(value));
}

test('development paths preserve the checkout layout without consulting process cwd', () => {
  const paths = development();
  assert.equal(paths.mode, 'DEVELOPMENT');
  assert.equal(paths.applicationRoot, resolve('/checkout'));
  assert.equal(paths.coreEntry, resolve('/checkout/dist/server/server/index.js'));
  assert.equal(paths.preloadEntry, resolve('/checkout/dist/desktop-preload/preload.cjs'));
  assert.equal(paths.rendererRoot, resolve('/checkout/dist/client'));
  assert.equal(paths.coreWorkingDirectory, resolve('/checkout'));
  assert.equal(paths.trayIcon, resolve('/checkout/public/brand/atlas-tray.ico'));
});

test('packaged paths separate immutable application resources from user data', () => {
  const paths = packaged();
  assert.equal(paths.mode, 'PACKAGED');
  assert.equal(paths.applicationRoot, resolve('/programs/Atlas/resources/app.asar'));
  assert.equal(paths.resourcesRoot, resolve('/programs/Atlas/resources'));
  assert.equal(paths.unpackedResourcesRoot, resolve('/programs/Atlas/resources/app.asar.unpacked'));
  assert.equal(paths.coreWorkingDirectory, resolve('/users/example/AppData/Roaming/Atlas'));
  for (const writable of [paths.dataRoot, paths.configRoot, paths.localDataRoot, paths.memoryPath, paths.credentialsRoot, paths.googleTokenPath, paths.gmailAccountsPath, paths.journalPath, paths.logsRoot, paths.cacheRoot]) {
    assert.equal(inside(paths.applicationRoot, writable), false, writable);
    assert.equal(inside(paths.resourcesRoot, writable), false, writable);
  }
});

test('packaged resolver rejects a writable root inside ASAR or installation resources', () => {
  assert.throws(() => resolveDesktopRuntimePaths({
    packaged: true,
    mainModulePath: '/programs/Atlas/resources/app.asar/dist/desktop-build/desktop/main.js',
    appPath: '/programs/Atlas/resources/app.asar',
    resourcesPath: '/programs/Atlas/resources',
    userDataPath: '/programs/Atlas/resources/user-data'
  }), /DATA_INSIDE_APPLICATION/);
});

test('Core environment is explicit, drops arbitrary inherited values and binds private data paths', () => {
  const paths = development();
  const env = desktopCoreEnvironment({
    OPENAI_API_KEY: 'private-fixture',
    USER_TIMEZONE: 'Europe/Madrid',
    BROWSER_ENABLED: 'false',
    UNRELATED_SECRET: 'must-not-cross',
    NODE_OPTIONS: '--inspect'
  }, paths);
  assert.equal(env.OPENAI_API_KEY, 'private-fixture');
  assert.equal(env.USER_TIMEZONE, 'Europe/Madrid');
  assert.equal(env.UNRELATED_SECRET, undefined);
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(env.ATLAS_CLIENT_ROOT, paths.rendererRoot);
  assert.equal(env.MEMORY_PATH, paths.memoryPath);
  assert.equal(env.GOOGLE_TOKEN_PATH, paths.googleTokenPath);
  assert.equal(env.GMAIL_ACCOUNTS_PATH, paths.gmailAccountsPath);
});

test('packaged Core environment excludes credentials reserved for the private delivery channel', () => {
  const env = desktopCoreEnvironment({
    OPENAI_API_KEY: 'private-fixture',
    GOOGLE_CLIENT_ID: 'private-client',
    GOOGLE_CLIENT_SECRET: 'private-secret',
    USER_TIMEZONE: 'Europe/Madrid'
  }, packaged());
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.GOOGLE_CLIENT_ID, undefined);
  assert.equal(env.GOOGLE_CLIENT_SECRET, undefined);
  assert.equal(env.USER_TIMEZONE, 'Europe/Madrid');
});

test('missing credentials and Browser Control configuration remain absent and fail closed', () => {
  const env = desktopCoreEnvironment({}, packaged());
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.GOOGLE_CLIENT_SECRET, undefined);
  assert.equal(env.ATLAS_BROWSER_HOST_PATH, undefined);
  assert.equal(env.ATLAS_BROWSER_EXTENSION_ID, undefined);
  assert.equal(env.BROWSER_ENABLED, undefined);
  assert.deepEqual(allowlistedCoreEnvironment({ PRIVATE_SENTINEL: 'not-allowed' }), {});
});

test('Desktop Core cannot bypass Main allowlisting through a cwd dotenv file', () => {
  assert.equal(coreMayLoadDotEnv({ ATLAS_DESKTOP_MODE: 'true' }), false);
  assert.equal(coreMayLoadDotEnv({}), true);
  assert.equal(coreMayLoadDotEnv({ ATLAS_DESKTOP_MODE: 'false' }), true);
});

test('memory, credentials and journal survive application path changes through stable userData binding', () => {
  const first = packaged('/programs/Atlas-v1/resources/app.asar');
  const next = packaged('/programs/Atlas-v2/resources/app.asar');
  assert.notEqual(first.applicationRoot, next.applicationRoot);
  assert.equal(first.memoryPath, next.memoryPath);
  assert.equal(first.googleTokenPath, next.googleTokenPath);
  assert.equal(first.gmailAccountsPath, next.gmailAccountsPath);
  assert.equal(first.journalPath, next.journalPath);
});
