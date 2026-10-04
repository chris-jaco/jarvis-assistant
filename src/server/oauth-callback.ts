import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
// Backend-only, single-use loopback challenge. No tokens or identity data here.
export class OAuthCallback {
  readonly redirect: URL;
  readonly state = randomBytes(32).toString('base64url');
  readonly verifier = randomBytes(32).toString('base64url');
  private consumed = false;
  private expired = false;
  constructor(uri: string) {
    this.redirect = new URL(uri);
    const u = this.redirect;
    if (u.protocol !== 'http:' || u.hostname !== '127.0.0.1' || u.pathname !== '/oauth/callback' || !u.port || u.search || u.hash || u.username || u.password) throw new Error('Use a loopback callback http://127.0.0.1:3001/oauth/callback');
  }
  challenge(): string { return createHash('sha256').update(this.verifier).digest('base64url'); }
  accept(method: string | undefined, url: URL): boolean {
    const value = Buffer.from(url.searchParams.get('state') ?? ''); const expected = Buffer.from(this.state);
    if (this.consumed || method !== 'GET' || url.origin !== this.redirect.origin || url.pathname !== this.redirect.pathname || value.length !== expected.length || !timingSafeEqual(value, expected)) return false;
    this.consumed = true; return true;
  }
  ensureActive(): void { if (this.expired) throw new Error('OAuth expired'); }
  close(): void { this.expired = true; this.consumed = true; }
}
