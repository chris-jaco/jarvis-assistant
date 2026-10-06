import type { SiteEnvironment } from './site-authorization.js';
const key = 'atlasSiteAuthorizationsV1';
export function chromeSiteEnvironment(api: Pick<typeof chrome, 'storage' | 'permissions'>): SiteEnvironment {
  return {
    load: async () => {
      await api.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
      return (await api.storage.local.get(key))[key];
    },
    save: async value => { await api.storage.local.set({ [key]: value }); },
    contains: pattern => api.permissions.contains({ origins: [pattern] }),
    remove: pattern => api.permissions.remove({ origins: [pattern] })
  };
}
