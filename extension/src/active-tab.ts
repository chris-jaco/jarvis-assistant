// A service worker has no dependable currentWindow. Never choose by origin,
// permission, title, result ordering, or the last window that happened to focus.
export type ActiveTab = { id?: number; windowId: number; url?: string; title?: string };
export type ResolvedActiveTab = {id:number;url:string;title:string};
export const activeTabErrors = ['ACTIVE_TAB_UNAVAILABLE', 'ACTIVE_TAB_AMBIGUOUS'] as const;
export async function resolveActiveTab(query: () => Promise<ActiveTab[]>): Promise<ResolvedActiveTab> {
  let tabs: ActiveTab[];
  try { tabs = await query(); } catch { throw new Error('ACTIVE_TAB_UNAVAILABLE'); }
  if (tabs.length > 1) throw new Error('ACTIVE_TAB_AMBIGUOUS');
  const tab = tabs[0];
  if (!tab || !Number.isInteger(tab.id) || tab.id! < 0 || !Number.isInteger(tab.windowId) || tab.windowId < 0 || !tab.url) throw new Error('ACTIVE_TAB_UNAVAILABLE');
  return {id:tab.id!,url:tab.url,title:tab.title ?? ''};
}

// The popup is the only extension surface that has a meaningful current
// window. Its authenticated message supplies the ID obtained from
// chrome.windows.getCurrent(); the worker still queries and validates the tab.
export async function resolvePopupActiveTab(windowId:number,query:(windowId:number)=>Promise<ActiveTab[]>):Promise<ResolvedActiveTab> {
  if(!Number.isInteger(windowId)||windowId<0)throw new Error('ACTIVE_TAB_UNAVAILABLE');
  return resolveActiveTab(async()=>{
    const tabs=await query(windowId);
    if(tabs.some(tab=>tab.windowId!==windowId))throw new Error('ACTIVE_TAB_UNAVAILABLE');
    return tabs;
  });
}
