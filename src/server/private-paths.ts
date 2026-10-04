export function privateRequestPath(url: string): boolean {
  try {
    let path = url.split('?')[0] ?? '';
    for (let i = 0; i < 3; i++) {
      const decoded = decodeURIComponent(path); if (decoded === path) break; path = decoded;
    }
    path = path.replaceAll('\\', '/').toLowerCase();
    return /(?:^|\/)(?:\.local|\.git)(?:\/|$)/.test(path) || /(?:^|\/)\.env(?:[./]|$)/.test(path) || /(?:^|\/)(?:[^/]*google-tokens[^/]*|g_[^/]+)\.json$/.test(path);
  } catch { return true; }
}
