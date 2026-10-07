import { z } from 'zod';
import { navigationUrl } from '../../src/browser/policy.js';

export function siteOrigin(raw: string): string {
  const origin = new URL(raw).origin;
  navigationUrl(origin);
  return origin;
}
export function hostPattern(origin: string): string {
  const exact = siteOrigin(origin);
  if (exact !== origin || !exact.startsWith('https://')) throw new Error('ACCESS_DENIED');
  return `${exact}/*`;
}
const originSchema = z.string().max(300).refine(value => {
  try { return siteOrigin(value) === value && value.startsWith('https://'); } catch { return false; }
});
const fileSchema = z.object({ version: z.literal(1), sites: z.array(z.object({ origin: originSchema, createdAt: z.number().int().nonnegative() }).strict()).max(100) }).strict();
export interface SiteEnvironment {
  load(): Promise<unknown>;
  save(value: z.infer<typeof fileSchema>): Promise<void>;
  contains(pattern: string): Promise<boolean>;
  remove(pattern: string): Promise<boolean>;
}
export class SiteAuthorization {
  private sites = new Map<string, number>();
  private blocked = new Set<string>(); private revisions = new Map<string,number>();
  private ready: Promise<void>;
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private readonly env: SiteEnvironment, private readonly invalidated: (origin: string) => Promise<void>, private readonly now = Date.now) {
    this.ready = env.load().then(raw => {
      if (raw === undefined) return;
      const file = fileSchema.parse(raw);
      this.sites = new Map(file.sites.map(site => [site.origin, site.createdAt]));
    });
    // A failed/corrupt load never creates permissions, nor an unhandled rejection.
    void this.ready.catch(() => {});
  }
  private write() { return this.env.save({ version: 1, sites: [...this.sites].map(([origin,createdAt]) => ({ origin,createdAt })) }); }
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.catch(() => {}).then(async () => { await this.ready; return work(); });
    this.tail = result; return result;
  }
  async allows(origin: string): Promise<boolean> {
    try {
      await this.ready;
      return !this.blocked.has(origin) && this.sites.has(origin) && await this.env.contains(hostPattern(origin)) && !this.blocked.has(origin);
    } catch { return false; }
  }
  // Read-only diagnostic view: never reconcile, persist or grant permissions.
  async diagnosticStatus(origin:string):Promise<{chromePermission:boolean;persistentPolicy:'ALLOW'|'ASK'}> {
    await this.ready;
    return {chromePermission:await this.env.contains(hostPattern(origin)),persistentPolicy:!this.blocked.has(origin)&&this.sites.has(origin)?'ALLOW':'ASK'};
  }
  // Only the packaged popup handler calls this, after the popup's real gesture
  // requests Chrome permission. Backend/native/content messages cannot call it.
  async allowAlways(origin: string): Promise<void> {
    hostPattern(origin); const revision = this.revisions.get(origin) ?? 0;
    await this.serial(async () => {
      if (revision !== (this.revisions.get(origin) ?? 0)) throw new Error('ACCESS_DENIED');
      if (!await this.env.contains(hostPattern(origin))) throw new Error('ACCESS_DENIED');
      if (!this.sites.has(origin) && this.sites.size >= 100) throw new Error('REJECTED');
      this.blocked.add(origin);
      this.sites.set(origin, this.now());
      try { await this.write(); if (revision !== (this.revisions.get(origin) ?? 0)) throw new Error('ACCESS_DENIED'); this.blocked.delete(origin); }
      catch { this.sites.delete(origin); await this.env.remove(hostPattern(origin)).catch(() => false); throw new Error('ACCESS_DENIED'); }
    });
  }
  async revoke(origin: string): Promise<void> {
    hostPattern(origin);
    this.revisions.set(origin,(this.revisions.get(origin) ?? 0)+1);
    this.blocked.add(origin); // Enforcement changes before any asynchronous I/O.
    await this.invalidated(origin);
    await this.serial(async () => {
      this.sites.delete(origin);
      const saved = await this.write().then(() => true, () => false);
      const removed = await this.env.remove(hostPattern(origin)).catch(() => false) || !await this.env.contains(hostPattern(origin)).catch(() => true);
      if (!saved || !removed) throw new Error('ACCESS_DENIED');
    });
  }
  async reconcile(): Promise<void> {
    await this.serial(async () => {
      let changed = false;
      for (const origin of this.sites.keys()) {
        if (!await this.env.contains(hostPattern(origin)).catch(() => false)) {
          this.blocked.add(origin); this.sites.delete(origin); changed = true;
          await this.invalidated(origin);
        }
      }
      if (changed) await this.write();
    });
  }
  async list(): Promise<{ origin: string; allowed: boolean }[]> {
    await this.reconcile();
    return [...this.sites.keys()].map(origin => ({ origin, allowed: !this.blocked.has(origin) }));
  }
}
