import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';

export const DESKTOP_AUTH_HEADER = 'x-atlas-desktop-auth';

export interface DesktopServerMode {
  enabled: boolean;
  secret?: string;
}

export function createDesktopSecret(): string { return randomBytes(32).toString('hex'); }

export function desktopServerMode(env: NodeJS.ProcessEnv, host: string): DesktopServerMode {
  const value = env.ATLAS_DESKTOP_MODE;
  if (value !== undefined && value !== 'true' && value !== 'false') throw new Error('ATLAS_DESKTOP_MODE must be true or false.');
  if (value !== 'true') return { enabled: false };
  if (host !== '127.0.0.1') throw new Error('Atlas Desktop Core must listen on 127.0.0.1.');
  const secret = env.ATLAS_DESKTOP_SECRET;
  if (!secret || !/^[a-f0-9]{64}$/.test(secret)) throw new Error('ATLAS_DESKTOP_SECRET must be a 32-byte lowercase hex credential.');
  return { enabled: true, secret };
}

export function desktopApiAuthorized(path: string, headers: IncomingHttpHeaders, mode: DesktopServerMode): boolean {
  if (!path.startsWith('/api/') || !mode.enabled) return true;
  const supplied = headers[DESKTOP_AUTH_HEADER];
  if (typeof supplied !== 'string' || !mode.secret || supplied.length !== mode.secret.length) return false;
  return timingSafeEqual(Buffer.from(supplied), Buffer.from(mode.secret));
}
