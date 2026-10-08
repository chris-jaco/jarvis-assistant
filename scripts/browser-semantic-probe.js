// Paste into DevTools on ONE manually opened test conversation. READ only.
// Returns structural counts/booleans; never reads textContent, innerText,
// field values, message history, URLs, cookies, storage or network data.
(() => {
  const visible = node => !node.closest('[hidden],[aria-hidden="true"],[inert]') && node.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}) && node.getBoundingClientRect().width > 0 && node.getBoundingClientRect().height > 0;
  const cap = count => Math.min(20,count);
  const logs = [...document.querySelectorAll('[role="log"]')].filter(visible);
  const composers = [...document.querySelectorAll('textarea,[role="textbox"][contenteditable="true"]')].filter(visible);
  const sends = [...document.querySelectorAll('button,[role="button"]')].filter(node => visible(node) && /^(send|enviar)$/i.test(node.getAttribute('aria-label') || ''));
  const ids = new Map();
  for (const node of document.querySelectorAll('[id]')) ids.set(node.id,(ids.get(node.id)||0)+1);
  const relationships = logs.slice(0,8).map(log => {
    const tokens = (log.getAttribute('aria-labelledby')||'').trim().split(/\s+/);
    const label = tokens.length===1 && tokens[0] ? document.getElementById(tokens[0]) : null;
    const usableLabel = !!label && visible(label) && !log.contains(label) && !label.contains(log) && ids.get(log.id)===1 && ids.get(label.id)===1;
    const associated = composers.filter(node => node.getAttribute('aria-controls')===log.id && !!log.id && !node.closest('[role="search"],form') && !node.matches(':disabled') && node.getAttribute('aria-disabled')!=='true');
    return {
      uniqueLogId:!!log.id && ids.get(log.id)===1,
      explicitVisibleRecipientLabel:usableLabel,
      visibleNameMarkers:usableLabel ? cap([...label.querySelectorAll('[itemprop="name"]')].filter(visible).length) : 0,
      visibleEmailMarkers:usableLabel ? cap([...label.querySelectorAll('[itemprop="email"]')].filter(visible).length) : 0,
      visiblePhoneMarkers:usableLabel ? cap([...label.querySelectorAll('[itemprop="telephone"]')].filter(visible).length) : 0,
      associatedComposers:cap(associated.length),
      associatedSendControls:cap(sends.filter(node => !!log.id && node.getAttribute('aria-controls')===log.id).length)
    };
  });
  console.log(JSON.stringify({probe:'ATLAS_SEMANTIC_STRUCTURE',version:1,readOnly:true,
    documentReady:document.readyState==='interactive'||document.readyState==='complete',
    visibleLogs:cap(logs.length),visibleComposerCandidates:cap(composers.length),
    visibleExplicitSendCandidates:cap(sends.length),truncated:logs.length>8,
    relationships,
    identityValuesInspected:false,activeConversationVerified:false,
    documentEpochVerified:false,nodeStabilityVerified:false
  },null,2));
})();
