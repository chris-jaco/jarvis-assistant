// A service worker has no dependable currentWindow. Never choose by origin,
// permission, title, result ordering, or the last window that happened to focus.
export type ActiveTab = { id?: number; windowId: number; url?: string; title?: string };
export const activeTabErrors = ['ACTIVE_TAB_UNAVAILABLE', 'ACTIVE_TAB_AMBIGUOUS'] as const;
export async function resolveActiveTab(query: () => Promise<ActiveTab[]>): Promise<{id:number;url:string;title:string}> {
  let tabs: ActiveTab[];
  try { tabs = await query(); } catch { throw new Error('ACTIVE_TAB_UNAVAILABLE'); }
  if (tabs.length > 1) throw new Error('ACTIVE_TAB_AMBIGUOUS');
  const tab = tabs[0];
  if (!tab || !Number.isInteger(tab.id) || tab.id! < 0 || !Number.isInteger(tab.windowId) || tab.windowId < 0 || !tab.url) throw new Error('ACTIVE_TAB_UNAVAILABLE');
  return {id:tab.id!,url:tab.url,title:tab.title ?? ''};
}
