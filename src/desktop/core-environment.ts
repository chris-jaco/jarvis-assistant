import type { DesktopRuntimePaths } from './runtime-paths.js';

// Values explicitly allowed to cross the Electron Main -> Atlas Core boundary.
// They are never persisted or logged here. OS values are required by Node,
// Windows ACL helpers, TLS and proxy-aware fetch implementations.
export const CORE_ENVIRONMENT_ALLOWLIST = [
  'OPENAI_API_KEY', 'USER_TIMEZONE', 'OPENAI_SEARCH_MODEL', 'TOOL_CONFIRM_WRITES',
  'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REDIRECT_URI', 'GOOGLE_CALENDAR_ID',
  'GOOGLE_TOKEN_PATH', 'GMAIL_ACCOUNTS_PATH',
  'MEMORY_PATH', 'MEMORY_CONTEXT_CHARS', 'MEMORY_RETRIEVAL_LIMIT', 'MEMORY_AUTOMATIC',
  'BROWSER_ENABLED', 'BROWSER_CHANNEL', 'BROWSER_TRACE', 'BROWSER_PROVIDER',
  'ATLAS_BROWSER_HOST_PATH', 'ATLAS_BROWSER_EXTENSION_ID', 'BROWSER_CONNECTION_ID',
  'ATLAS_ACCESS_TRACE', 'JARVIS_CONFIRMATION_TRACE', 'JARVIS_MEMORY_PROFILE',
  'ATLAS_CLIENT_ROOT',
  'SystemRoot', 'WINDIR', 'ComSpec', 'PATH', 'PATHEXT', 'TEMP', 'TMP',
  'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'HOMEDRIVE', 'HOMEPATH',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY',
  'http_proxy', 'https_proxy', 'no_proxy', 'all_proxy',
  'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR'
] as const;

const PACKAGED_PRIVATE_CREDENTIALS = [
  'OPENAI_API_KEY', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'
] as const;

export function allowlistedCoreEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const key of CORE_ENVIRONMENT_ALLOWLIST) {
    const value = source[key];
    if (value !== undefined) result[key] = value;
  }
  return result;
}

export function coreMayLoadDotEnv(source: NodeJS.ProcessEnv): boolean {
  return source.ATLAS_DESKTOP_MODE !== 'true';
}

export function desktopCoreEnvironment(source: NodeJS.ProcessEnv, paths: DesktopRuntimePaths): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    ...allowlistedCoreEnvironment(source),
    ATLAS_CLIENT_ROOT: paths.rendererRoot,
    MEMORY_PATH: paths.memoryPath,
    GOOGLE_TOKEN_PATH: paths.googleTokenPath,
    GMAIL_ACCOUNTS_PATH: paths.gmailAccountsPath
  };
  if (paths.mode === 'PACKAGED') {
    for (const key of PACKAGED_PRIVATE_CREDENTIALS) delete environment[key];
  }
  return environment;
}

