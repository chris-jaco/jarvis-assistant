// Manual DevTools selection only. See docs/browser-whatsapp-structural-probe.md.
// A: select the conversation panel in Elements, then run this file unchanged.
// B: edit ONLY this configuration as documented; never paste private values.
(async () => {
  const configuration = { state: 'A', conversationRoot: $0, contactPanel: null, phoneField: null };
  const tags = new Set(['MAIN','SECTION','ARTICLE','ASIDE','HEADER','FOOTER','DIV','SPAN','P','FORM','TEXTAREA','INPUT','BUTTON','A','H1','H2','H3']);
  const roles = new Set(['main','region','group','dialog','complementary','heading','textbox','searchbox','button','log','list','application']);
  const shape = node => ({tag:tags.has(node.tagName)?node.tagName.toLowerCase():'other',role:roles.has(node.getAttribute('role'))?node.getAttribute('role'):'other',labelType:node.hasAttribute('aria-labelledby')?'LABELLEDBY':node.hasAttribute('aria-label')?'ARIA_LABEL':node.hasAttribute('title')?'TITLE':'NONE'});
  const visible = node => !node.closest('[hidden],[aria-hidden="true"],[inert]') && node.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}) && node.getBoundingClientRect().width>0 && node.getBoundingClientRect().height>0;
  const enabled = node => !node.matches(':disabled') && node.getAttribute('aria-disabled')!=='true' && node.getAttribute('aria-readonly')!=='true' && !node.hasAttribute('readonly');
  const root=configuration.conversationRoot,panel=configuration.contactPanel,field=configuration.phoneField;
  const valid = node => node && node.ownerDocument===document && node.isConnected && node.nodeType===1 && node!==document.body && node!==document.documentElement;
  if(!['A','B'].includes(configuration.state)||!valid(root)||!visible(root)) {console.log(JSON.stringify({probe:configuration.state==='B'?'ATLAS_WHATSAPP_STRUCTURE_B':'ATLAS_WHATSAPP_STRUCTURE_A',outcome:'NOT_VERIFIED',reason:'INVALID_MANUAL_SCOPE'}));return;}
  const panelValid=configuration.state==='B'&&valid(panel)&&visible(panel)&&panel!==root&&!root.contains(panel)&&!panel.contains(root);
  const limit=40;
  const bounded=(scope,selector)=>{const result=[];const iterator=scope.querySelectorAll(selector);for(let i=0;i<Math.min(iterator.length,200)&&result.length<=limit;i++)if(visible(iterator[i]))result.push(iterator[i]);return {nodes:result.slice(0,limit),truncated:result.length>limit||iterator.length>200};};
  const sample=()=>{
    const composers=bounded(root,'textarea,[contenteditable="true"][role="textbox"]');
    const headers=bounded(root,'header,[role="heading"],h1,h2,h3');
    const buttons=bounded(root,'button,[role="button"]');
    const structural=bounded(root,'main,section,article,aside,[role="main"],[role="region"],[role="group"],[role="log"]');
    // Read Send labels only near the composer, never on history buttons.
    const nearby=buttons.nodes.filter(node=>composers.nodes.some(composer=>{const parent=composer.parentElement;return parent&&parent!==root&&!parent.querySelector('header,[role="log"]')&&parent.contains(node);}));
    const send=nearby.filter(node=>/^(send|enviar)$/i.test(node.getAttribute('aria-label')||''));
    return {composers,headers,buttons,structural,send,nearby};
  };
  const ancestors=node=>{const result=[];let parent=node.parentElement;for(let n=0;parent&&parent!==root&&n<4;n++,parent=parent.parentElement)result.push(parent);return result;};
  const startedAt=Date.now(),rootParent=root.parentElement;const first=sample();
  const firstShapes={},firstEnabled={},firstAncestors={};for(const key of ['composers','headers','buttons']){firstShapes[key]=first[key].nodes.map(shape);firstEnabled[key]=first[key].nodes.map(enabled);firstAncestors[key]=first[key].nodes.map(ancestors);}
  await new Promise(resolve=>setTimeout(resolve,200));const second=sample();
  const elapsedMs=Math.min(30_000,Math.max(0,Date.now()-startedAt));
  const connected=elapsedMs<=1000&&root.parentElement===rootParent&&valid(root)&&visible(root)&&(!panelValid||valid(panel)&&visible(panel));
  const stable = key => connected && first[key].nodes.length===second[key].nodes.length && !first[key].truncated && !second[key].truncated && first[key].nodes.every((node,index)=>node===second[key].nodes[index]&&node.isConnected&&JSON.stringify(shape(node))===JSON.stringify(firstShapes[key][index])&&enabled(node)===firstEnabled[key][index]&&ancestors(node).length===firstAncestors[key][index].length&&ancestors(node).every((parent,n)=>parent===firstAncestors[key][index][n]));
  const evidence=()=>{
    if(!connected||!panelValid||!valid(field)||!visible(field)||!panel.contains(field)||root.contains(field)||!['SPAN','P','DIV'].includes(field.tagName)||field.childElementCount!==0||field.closest('[contenteditable="true"],input,textarea,[role="log"]'))return 'NOT_VERIFIED';
    const nodes=field.childNodes;if(nodes.length!==1||nodes[0].nodeType!==3||nodes[0].length>64)return 'NOT_VERIFIED';
    return /^\+[1-9][0-9 ()-]{5,24}$/.test(nodes[0].data.trim())?'PRESENT':'NOT_VERIFIED';
  };
  console.log(JSON.stringify({probe:configuration.state==='B'?'ATLAS_WHATSAPP_STRUCTURE_B':'ATLAS_WHATSAPP_STRUCTURE_A',version:1,readOnly:true,
    manualConversationScope:true,conversation:shape(root),contactPanel:{manuallyScoped:!!panelValid,shape:panelValid?shape(panel):null,association:'NOT_VERIFIED'},
    counts:{panelCandidates:second.structural.nodes.length,headers:second.headers.nodes.length,composers:second.composers.nodes.length,enabledComposers:second.composers.nodes.filter(enabled).length,buttons:second.buttons.nodes.length,explicitSendCandidates:second.send.length},
    composers:second.composers.nodes.slice(0,4).map(node=>({...shape(node),enabled:enabled(node),insideSelectedConversation:root.contains(node),ancestorShapes:(()=>{const result=[];let parent=node.parentElement;for(let n=0;parent&&parent!==root&&n<4;n++,parent=parent.parentElement)result.push(shape(parent));return result;})()})),
    headers:second.headers.nodes.slice(0,4).map(shape),buttonsNearComposer:second.nearby.slice(0,4).map(node=>({...shape(node),enabled:enabled(node),hasSvg:!!node.querySelector('svg')})),sendCandidates:second.send.slice(0,4).map(node=>({...shape(node),enabled:enabled(node),sharesComposerParent:second.composers.nodes.some(composer=>composer.parentElement===node.parentElement)})),
    phoneEvidence:evidence(),identityVerified:false,activeConversationBinding:'NOT_VERIFIED',documentEpoch:'NOT_VERIFIED',
    sampledNodeStability:{durationMs:elapsedMs,withinSamplingWindow:elapsedMs<=1000,composers:stable('composers'),headers:stable('headers'),buttons:stable('buttons')},
    truncated:Object.values(second).some(value=>value&&value.truncated)||Object.values(first).some(value=>value&&value.truncated),
    sufficientForAdapterImplementation:false,adapterDesignEvidence:connected&&!second.composers.truncated&&second.composers.nodes.length===1&&second.headers.nodes.length>0?'PARTIAL':'NOT_VERIFIED'
  },null,2));
})();
