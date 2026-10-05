// Fixed trusted code, never caller-provided JS. Extract metadata and retain only
// bounded visible handles in one renderer round-trip; never read input values.
export const observationScript = String.raw`(() => {
  const visible = el => el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) && !el.closest('[hidden],[aria-hidden="true"],[inert]');
  const dialogs = Array.from(document.querySelectorAll('dialog[open],[role="dialog"],[role="alertdialog"],[aria-modal="true"]')).filter(visible);
  const modal = dialogs.at(-1);
  const scope = modal || document;
  const cookieDialog = !!modal && /\b(cookies?|galletas)\b/i.test((modal.innerText || '').slice(0, 2000));
  const candidates = Array.from(scope.querySelectorAll('a[href],button,input,textarea,select,[role="button"],[role="searchbox"],[role="textbox"],video,audio'));
  const nodes = [];
  let truncated = false;
  for (const el of candidates) {
    if (!visible(el) || ['password','hidden'].includes(el.type) || /password|one-time-code|cc-/.test(el.autocomplete || '')) continue;
    const rect = el.getBoundingClientRect();
    const x = Math.max(0, Math.min(innerWidth - 1, rect.left + rect.width / 2));
    const y = Math.max(0, Math.min(innerHeight - 1, rect.top + rect.height / 2));
    const hit = document.elementFromPoint(x, y);
    if (!rect.width || !rect.height || !hit || !(el === hit || el.contains(hit))) continue;
    if (nodes.length >= 80) { truncated = true; break; }
    const tag = el.tagName.toLowerCase();
    const declared = el.getAttribute('role') || '';
    const role = (['link','button','textbox','searchbox','combobox','checkbox','radio','slider','switch'].includes(declared) ? declared : undefined) || ({a:'link',input:el.type === 'search' ? 'searchbox' : 'textbox',textarea:'textbox',button:'button',select:'combobox',video:'media',audio:'media'})[tag] || 'button';
    const labelled = (el.getAttribute('aria-labelledby') || '').split(/\s+/).map(id => document.getElementById(id)?.textContent || '').join(' ');
    const name = el.getAttribute('aria-label') || labelled.trim() || Array.from(el.labels || []).map(label => label.textContent).join(' ') || el.getAttribute('placeholder') || (['input','textarea','select'].includes(tag) || ['textbox','searchbox'].includes(role) || el.isContentEditable ? '' : el.textContent) || el.getAttribute('title') || tag;
    nodes.push({ node: el, raw: { tag, role, name: name.slice(0,500), type: el.type || '', disabled: !!el.disabled || el.getAttribute('aria-disabled') === 'true', href: tag === 'a' ? el.href : undefined, cookieDialog,
      state: { ...(['video','audio'].includes(tag) ? {paused:el.paused} : {}), ...(['checkbox','radio'].includes(el.type) ? {checked:el.checked} : {}), ...(el.hasAttribute('aria-expanded') ? {expanded:el.getAttribute('aria-expanded') === 'true'} : {}) },
      search: el.type === 'search' || role === 'searchbox' || !!el.closest('[role="search"]') || /^(search|buscar|búsqueda|rechercher|suche)(\b|$)/i.test(name.trim()) } });
  }
  const dialogName = modal && (modal.getAttribute('aria-label') || (modal.getAttribute('aria-labelledby') || '').split(/\s+/).map(id => document.getElementById(id)?.textContent || '').join(' ') || modal.querySelector('h1,h2,h3')?.textContent || 'Dialog');
  return { nodes, revision: window.__atlasRevision, truncated, dialog: modal ? {role:modal.getAttribute('role') || 'dialog', name:dialogName.slice(0,120)} : undefined };
})()`;
