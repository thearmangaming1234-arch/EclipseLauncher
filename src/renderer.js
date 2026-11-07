let instances=[];
let newsItems=[];
let profiles=[];
let selectedProfileId=null;
let selectedInstanceFolder=null;
let currentBackgroundImageUrl='';
let savedModsInstanceFolder='';
let pinnedInstanceFolders=[];
let sidebarOrder=['home','mods','profile','settings'];
let newsEnabled=true;
let showPlaytime=true;
let playtimePosition='left';
let performanceModsEnabledByDefault=false;
let utilityModsEnabledByDefault=false;
let tlSkinsEnabledByDefault=false;
let newsRefreshTimer=null;
let noteSaveTimer=null;
let noteSelectionRange=null;
let removeProfileTarget=null;
let renameInstanceTarget=null;
let renameInstanceIcon='';
let deleteInstanceTarget=null;
let deleteInstanceStage=1;
let deletingInstance=false;
let resetPlaytimeTarget=null;
let resettingPlaytime=false;
let removeModTarget=null;
let modInstallBusy=false;
let modSearchRequestId=0;
let modSearchDebounceTimer=null;
let modProgressDismissTimer=null;
let activeModsCategory='mods';
let activeModsTab='installed';
let installedModsCache=[];
let installedModsCacheFolder=null;
let installedModsCacheFailed=false;
const installedAssetCaches={resourcepack:[],shader:[]};
const installedAssetCacheFolders={resourcepack:null,shader:null};
const installedAssetCacheFailed={resourcepack:false,shader:false};
const assetListRequestIds={resourcepack:0,shader:0};
let installedModFilter='all';
let installedModQuery='';
let lastModrinthProjects=[];
let lastModrinthInstanceInstalled=false;
let modDiscoveryProjects=[];
let modDiscoveryOffset=0;
let modDiscoveryTotalHits=0;
let modDiscoveryRequestId=0;
let modDiscoveryLoading=false;
let modDiscoveryExhausted=false;
let modDiscoveryKey='';
let modDiscoveryScrollBound=false;
let diagnosticLogEntries=[];
let diagnosticReadSequence=0;
const modsListRequests=new Map();
let pageAnimationTimer=null;
let pageAnimationDuration=450;
let installProgressTimer=null;
let installingInstanceFolder=null;
let launchingInstanceFolder=null;
let playingInstanceFolder=null;
let selectedControlsShouldAnimate=false;
const skinUrlRequests=new Map();
const skinDataRequests=new Map();
let skinViewer=null;
const minecraftVersionChoicesByLoader={};
let minecraftVersionLoadSequence=0;
const performanceOptionCache={};
let performanceOptionLoadSequence=0;
const utilityOptionCache={};
let utilityOptionLoadSequence=0;
let currentUtilityOptions=[];
let currentUtilityOptionKey='';
let eclipseCustomizationOptionSequence=0;
let eclipseCustomizationTypingTimer=null;
const tlSkinOptionCache={};
let tlSkinOptionLoadSequence=0;
const omittedPerformanceModIds=new Set();
const omittedUtilityModIds=new Set();
let currentPerformanceOptions=[];
let currentPerformanceOptionKey='';
let currentTLSkinOption=null;
let currentTLSkinOptionKey='';
let createErrorTypingTimer=null;
let tlSkinTypingTimer=null;

const animationDurations={fast:280,normal:450,relaxed:700,slow:1000,off:0};
const sidebarPageLabels={home:'Home',mods:'Mods',profile:'Profile',settings:'Settings'};

const $=s=>document.querySelector(s);
const $$=s=>document.querySelectorAll(s);

async function init(){
  const settings=await window.eclipse.settings.get();
  savedModsInstanceFolder=settings.modsInstanceFolder||'';
  pinnedInstanceFolders=settings.pinnedInstances||[];
  performanceModsEnabledByDefault=settings.performanceModsEnabledByDefault===true;
  utilityModsEnabledByDefault=settings.utilityModsEnabledByDefault===true;
  tlSkinsEnabledByDefault=settings.useTLSkinsEnabledByDefault===true;
  $('#microsoftClientId').value=settings.microsoftClientId||'';
  applySettings(settings);
  renderProfiles(settings);
  instances=await window.eclipse.instances.list();
  selectedInstanceFolder=null;
  const validPins=pinnedInstanceFolders.filter(folder=>instances.some(instance=>instance.folder===folder&&instance.installed));
  if(validPins.length!==pinnedInstanceFolders.length) await window.eclipse.settings.set({pinnedInstances:validPins});
  pinnedInstanceFolders=validPins;
  renderInstances();
  renderQuick();
  setupModsPage();
  renderPlaytimeSettings();
  if(newsEnabled){
    await loadNews();
    startNewsRefresh();
  }
}

function setupModsPage(){
  const select=$('#modInstance');
  select.innerHTML=instances.length?instances.map(instance=>`<option value="${escapeHtml(instance.folder)}">${escapeHtml(instance.name||instance.folder)} · ${escapeHtml(instance.version||'Unknown')}</option>`).join(''):'<option value="">No instances found</option>';
  if(instances.some(instance=>instance.folder===savedModsInstanceFolder))select.value=savedModsInstanceFolder;
  else select.value=instances[0]?.folder||'';
  select.disabled=!instances.length;
  $('#modInstanceDropdownTrigger').disabled=!instances.length;
  $('#modInstanceDropdownMenu').innerHTML=[...select.options].map(option=>{
    const instance=instances.find(item=>item.folder===option.value);
    const icon=instance?loaderLogoAsset(instance.loader):'';
    const selected=option.value===select.value;
    return `<button class="custom-select-option${selected?' selected':''}" type="button" role="option" data-value="${escapeHtml(option.value)}" aria-selected="${selected}" tabindex="-1">${icon?`<img class="mod-instance-loader-icon" src="../assets/${icon}" alt="">`:''}<span>${escapeHtml(option.textContent)}</span></button>`;
  }).join('');
  syncCustomDropdown('modInstance');
  select.onchange=()=>{
    savedModsInstanceFolder=select.value;
    window.eclipse.settings.set({modsInstanceFolder:savedModsInstanceFolder}).catch(error=>showInstanceNotice(`Could not save the selected Mods instance: ${error.message}`));
    modSearchRequestId++;
    modDiscoveryRequestId++;
    modDiscoveryLoading=false;
    modDiscoveryProjects=[];
    modDiscoveryOffset=0;
    modDiscoveryTotalHits=0;
    modDiscoveryExhausted=false;
    modDiscoveryKey='';
    $('#modResults').innerHTML='';
    $('#modDiscoverySentinel').hidden=true;
    lastModrinthProjects=[];
    installedAssetCaches.resourcepack=[];
    installedAssetCaches.shader=[];
    installedAssetCacheFolders.resourcepack=null;
    installedAssetCacheFolders.shader=null;
    installedAssetCacheFailed.resourcepack=false;
    installedAssetCacheFailed.shader=false;
    updateAssetCounts();
    $('#modSearchMessage').textContent='Search Modrinth for mods compatible with the selected instance.';
    $('#modInstallProgress').hidden=true;
    $('#modInstallProgress').classList.remove('error','complete');
    installedModsCache=[];
    installedModsCacheFolder=null;
    installedModsCacheFailed=false;
    refreshCurrentInstalledContent();
    if(activeModsTab==='modrinth'){
      if($('#modSearch').value.trim())searchModrinth();
      else loadModDiscovery(true);
    }
  };
  $('#modCategoryMods').onclick=()=>setModsCategory('mods');
  $('#modCategoryResourcepacks').onclick=()=>setModsCategory('resourcepack');
  $('#modCategoryShaders').onclick=()=>setModsCategory('shader');
  $('#installedModsTab').onclick=()=>setModsTab('installed');
  $('#modrinthTab').onclick=()=>setModsTab('modrinth');
  $('#refreshMods').onclick=()=>refreshCurrentInstalledContent();
  $('#openModsFolder').onclick=async()=>{
    try{await window.eclipse.mods.openFolder($('#modInstance').value,activeModsCategory);}
    catch(error){showInstanceNotice(error.message||'Could not open the selected content folder.');}
  };
  $('#modSearchForm').onsubmit=event=>{event.preventDefault();};
  $('#modSearch').oninput=()=>{
    clearTimeout(modSearchDebounceTimer);
    const query=$('#modSearch').value.trim();
    modSearchRequestId++;
    if(!query){lastModrinthProjects=[];$('#modResults').innerHTML='';loadModDiscovery(true);return;}
    modDiscoveryRequestId++;
    modDiscoveryLoading=false;
    $('#modDiscoverySentinel').hidden=true;
    lastModrinthProjects=[];
    $('#modResults').innerHTML='';
    $('#modSearchMessage').textContent='Searching compatible mods…';
    modSearchDebounceTimer=setTimeout(()=>searchModrinth(),280);
  };
  $('#modList').onclick=event=>activeModsCategory==='mods'?handleInstalledModAction(event):handleInstalledAssetAction(event);
  $('#installedModSearch').oninput=()=>{installedModQuery=$('#installedModSearch').value.trim().toLocaleLowerCase();if(activeModsCategory==='mods')renderFilteredInstalledMods();else renderInstalledAssets(activeModsCategory);};
  $('#installedModFilters').onclick=event=>{
    const button=event.target.closest('[data-mod-filter]');
    if(!button)return;
    installedModFilter=button.dataset.modFilter;
    $$('#installedModFilters [data-mod-filter]').forEach(item=>{const active=item===button;item.classList.toggle('active',active);item.setAttribute('aria-pressed',String(active));});
    renderFilteredInstalledMods();
  };
  $('#modResults').onclick=handleModrinthAction;
  $('#modDiscoveryLoadMore').onclick=()=>loadModDiscovery();
  if(!modDiscoveryScrollBound){
    $('main').addEventListener('scroll',()=>{
      const main=$('main');
      if(activeModsTab!=='modrinth'||$('#modSearch').value.trim()||main.scrollTop<=0)return;
      if(main.scrollHeight-main.clientHeight-main.scrollTop<=260)loadModDiscovery();
    },{passive:true});
    modDiscoveryScrollBound=true;
  }
  $('#removeModCancel').onclick=closeRemoveModDialog;
  $('#removeModDialog').onclick=event=>{if(event.target.id==='removeModDialog')closeRemoveModDialog();};
  $('#removeModConfirm').onclick=confirmRemoveMod;
  updateModInstanceStatus();
}

function loaderLogoAsset(loader){
  return {fabric:'fabriclogo230x230.png',forge:'forgelogo275x180.png',vanilla:'vanillalogo428x428.png'}[String(loader||'').toLowerCase()]||'';
}

function setModsTab(tab){
  activeModsTab=tab==='modrinth'?'modrinth':'installed';
  const installed=activeModsTab==='installed';
  $('#installedModsTab').classList.toggle('active',installed);
  $('#installedModsTab').setAttribute('aria-selected',String(installed));
  $('#modrinthTab').classList.toggle('active',!installed);
  $('#modrinthTab').setAttribute('aria-selected',String(!installed));
  $('#installedModsView').hidden=!installed;
  $('#modrinthView').hidden=installed;
  if(installed)refreshCurrentInstalledContent();
  else {
    refreshCurrentInstalledContent();
    updateModInstanceStatus();
    if($('#modSearch').value.trim())searchModrinth();
    else loadModDiscovery(true);
  }
}

function setModsCategory(category){
  if(!['mods','resourcepack','shader'].includes(category))return;
  if(activeModsCategory===category)return;
  activeModsCategory=category;
  const categories=[['mods','#modCategoryMods'],['resourcepack','#modCategoryResourcepacks'],['shader','#modCategoryShaders']];
  for(const [key,selector] of categories){
    const button=$(selector),active=key===category;
    button.classList.toggle('active',active);
    button.setAttribute('aria-selected',String(active));
  }
  const asset=category!=='mods';
  const pack=category==='resourcepack';
  $('#installedCategoryTitle').textContent=pack?'Installed resource packs':asset?'Installed shaders':'Installed mods';
  $('#installedCategoryDescription').textContent=pack
    ?'Resource packs are managed and enabled in Minecraft’s Resource Packs menu.'
    :asset?'Shader packs are managed and enabled in your in-game shader settings.':'Enable, disable, or remove mods. Pack-included mods are tagged Built-in.';
  $('#modrinthCategoryTitle').textContent=pack?'Find resource packs on Modrinth':asset?'Find shaders on Modrinth':'Find mods on Modrinth';
  $('#modrinthCategoryDescription').textContent=pack
    ?'Discover resource packs compatible with this Minecraft version.'
    :asset?'Discover shader packs compatible with this Minecraft version. Shaders need a compatible shader loader in game.':'Results match this instance’s Minecraft version and mod loader. Required dependencies install automatically.';
  $('#installedModSearch').placeholder=pack?'Search installed resource packs...':asset?'Search installed shaders...':'Search installed mods...';
  $('#openModsFolder').title=pack?'Open resource packs folder':asset?'Open shader packs folder':'Open mods folder';
  $('#openModsFolder').setAttribute('aria-label',pack?'Open selected instance resource packs folder':asset?'Open selected instance shader packs folder':'Open selected instance mods folder');
  $('#installedModFilters').hidden=asset;
  $('#installedModSearch').value='';
  installedModQuery='';
  $('#modSearch').value='';
  clearTimeout(modSearchDebounceTimer);
  modSearchRequestId++;
  modDiscoveryRequestId++;
  modDiscoveryLoading=false;
  modDiscoveryProjects=[];
  modDiscoveryOffset=0;
  modDiscoveryTotalHits=0;
  modDiscoveryExhausted=false;
  modDiscoveryKey='';
  lastModrinthProjects=[];
  $('#modResults').innerHTML='';
  $('#modDiscoverySentinel').hidden=true;
  refreshCurrentInstalledContent();
  if(activeModsTab==='modrinth')loadModDiscovery(true);
}

function refreshCurrentInstalledContent(){
  return activeModsCategory==='mods'?refreshInstalledMods():refreshInstalledAssets(activeModsCategory);
}

function updateModInstanceStatus(installedOverride){
  const instance=instances.find(item=>item.folder===$('#modInstance').value);
  const installed=typeof installedOverride==='boolean'?installedOverride:Boolean(instance?.installed);
  const status=$('#modInstanceStatus');
  status.classList.toggle('not-installed',!installed);
  const loader=String(instance?.loader||'Fabric');
  status.innerHTML=instance?`<span class="mod-status-dot"></span><b>${installed?'Installed':'Not installed'}</b><span>${escapeHtml(instance.name||instance.folder)} · Minecraft ${escapeHtml(instance.version||'Unknown')} · ${escapeHtml(loader)}</span>`:'No Minecraft instances were found.';
}

async function refreshInstalledMods(){
  const folder=$('#modInstance').value;
  const instance=instances.find(item=>item.folder===folder);
  const list=$('#modList');
  if(!instance){installedModsCache=[];installedModsCacheFolder=null;if(activeModsCategory==='mods'&&activeModsTab==='installed')list.innerHTML='<div class="mod-empty-card">No instances were found. Add an instance before managing mods.</div>';updateAssetCounts();updateModInstanceStatus(false);return;}
  if(String(instance.loader||'').toLowerCase()==='vanilla'){
    installedModsCache=[];installedModsCacheFolder=folder;installedModsCacheFailed=false;updateAssetCounts();updateModInstanceStatus(Boolean(instance.installed));
    const explanation=`<div class="mod-empty-card"><span class="mod-empty-icon">ⓘ</span><h3>Vanilla instances do not support mods</h3><p>Choose a Fabric or Forge instance to browse and manage mods.</p></div>`;
    if(activeModsTab==='installed')list.innerHTML=explanation;else{$('#modDiscoverySentinel').hidden=true;$('#modResults').innerHTML=explanation;}
    $('#modSearchMessage').textContent='Mods require a Fabric or Forge instance.';
    return;
  }
  installedModsCacheFailed=false;
  if(activeModsCategory==='mods'&&activeModsTab==='installed'){$('#installedModCount').textContent='…';list.innerHTML='<div class="mod-empty-card mod-loading"><span class="mod-spinner"></span>Loading this instance’s mods…</div>';}
  updateModInstanceStatus();
  try{
    const result=await getInstanceMods(folder);
    if(folder!==$('#modInstance').value)return;
    installedModsCache=result.installed?result.mods:[];
    installedModsCacheFolder=folder;
    installedModsCacheFailed=false;
    updateModInstanceStatus(result.installed);
    if(!result.installed){
      updateAssetCounts();
      if(activeModsCategory==='mods'&&activeModsTab==='installed')list.innerHTML=`<div class="mod-empty-card"><span class="mod-empty-icon">↓</span><h3>${escapeHtml(instance.name||instance.folder)} isn’t installed</h3><p>Install the instance from Home first. Once it’s ready, its mods will appear here.</p></div>`;
      else if(activeModsCategory==='mods'&&activeModsTab==='modrinth')renderCurrentModrinthView();
      updateAssetCounts();
      return;
    }
    if(activeModsCategory==='mods')$('#installedModCount').textContent=String(result.mods.length);
    else updateAssetCounts();
    if(activeModsCategory==='mods'&&activeModsTab==='installed')renderFilteredInstalledMods();
    else if(activeModsCategory==='mods'&&activeModsTab==='modrinth')renderCurrentModrinthView();
  }catch(error){
    if(folder!==$('#modInstance').value)return;
    installedModsCache=[];
    installedModsCacheFolder=null;
    installedModsCacheFailed=true;
    updateAssetCounts();
    if(activeModsCategory==='mods'&&activeModsTab==='installed'){
      list.innerHTML=`<div class="mod-empty-card mod-error"><h3>Couldn’t read this instance’s mods</h3><p>${escapeHtml(error.message)}</p><button class="mod-inline-link" type="button" data-retry-mods>Try again</button></div>`;
      list.querySelector('[data-retry-mods]').onclick=refreshInstalledMods;
    }else if(activeModsCategory==='mods'&&activeModsTab==='modrinth')renderCurrentModrinthView();
  }
}

function getInstanceMods(folder){
  if(!modsListRequests.has(folder)){
    let timeout;
    const request=Promise.race([
      window.eclipse.mods.list(folder),
      new Promise((_,reject)=>{timeout=setTimeout(()=>reject(new Error('Reading this instance’s mods took too long. Try Refresh again.')),15000);})
    ]).finally(()=>{clearTimeout(timeout);if(modsListRequests.get(folder)===request)modsListRequests.delete(folder);});
    modsListRequests.set(folder,request);
  }
  return modsListRequests.get(folder);
}

async function refreshInstalledAssets(assetType){
  const folder=$('#modInstance').value;
  const instance=instances.find(item=>item.folder===folder);
  const requestId=++assetListRequestIds[assetType];
  if(!instance){
    installedAssetCaches[assetType]=[];
    installedAssetCacheFolders[assetType]=null;
    installedAssetCacheFailed[assetType]=false;
    if(activeModsCategory===assetType)$('#modList').innerHTML='<div class="mod-empty-card">No instances were found. Add an instance first.</div>';
    updateAssetCounts();
    return;
  }
  if(activeModsCategory===assetType)$('#installedModCount').textContent='…';
  if(activeModsCategory===assetType)$('#modList').innerHTML=`<div class="mod-empty-card mod-loading"><span class="mod-spinner"></span>Loading installed ${assetType==='resourcepack'?'resource packs':'shaders'}…</div>`;
  try{
    const result=await window.eclipse.mods.listAssets(folder,assetType);
    if(requestId!==assetListRequestIds[assetType]||folder!==$('#modInstance').value)return;
    installedAssetCaches[assetType]=result.assets||[];
    installedAssetCacheFolders[assetType]=folder;
    installedAssetCacheFailed[assetType]=false;
    updateAssetCounts();
    if(activeModsCategory===assetType){
      if(activeModsTab==='installed')renderInstalledAssets(assetType,result.installed);
      else renderCurrentModrinthView();
    }
  }catch(error){
    if(requestId!==assetListRequestIds[assetType]||folder!==$('#modInstance').value)return;
    installedAssetCaches[assetType]=[];
    installedAssetCacheFolders[assetType]=null;
    installedAssetCacheFailed[assetType]=true;
    updateAssetCounts();
    if(activeModsCategory===assetType){
      if(activeModsTab==='installed'){
        $('#modList').innerHTML=`<div class="mod-empty-card mod-error"><h3>Couldn’t read installed ${assetType==='resourcepack'?'resource packs':'shaders'}</h3><p>${escapeHtml(error.message)}</p><button class="mod-inline-link" type="button" data-retry-assets>Try again</button></div>`;
        $('#modList').querySelector('[data-retry-assets]')?.addEventListener('click',()=>refreshInstalledAssets(assetType));
      }else renderCurrentModrinthView();
    }
  }
}

function updateAssetCounts(){
  $('#installedModCount').textContent=String(activeModsCategory==='mods'?installedModsCache.length:installedAssetCaches[activeModsCategory].length);
}

function renderInstalledAssets(assetType,installed=true){
  if(activeModsCategory!==assetType||activeModsTab!=='installed')return;
  const list=$('#modList');
  const instance=instances.find(item=>item.folder===$('#modInstance').value);
  if(!installed||instance?.installed===false){
    list.innerHTML=`<div class="mod-empty-card"><span class="mod-empty-icon">↓</span><h3>${escapeHtml(instance?.name||'This instance')} isn’t installed</h3><p>Install the instance from Home first. Its ${assetType==='resourcepack'?'resource packs':'shaders'} will appear here.</p></div>`;
    return;
  }
  const query=installedModQuery;
  const assets=installedAssetCaches[assetType].filter(asset=>`${asset.name} ${asset.fileName} ${asset.slug}`.toLocaleLowerCase().includes(query));
  if(!installedAssetCaches[assetType].length){
    list.innerHTML=`<div class="mod-empty-card"><span class="mod-empty-icon">✣</span><h3>No ${assetType==='resourcepack'?'resource packs':'shaders'} found</h3><p>This instance’s ${assetType==='resourcepack'?'resourcepacks':'shaderpacks'} folder is empty. Discover compatible content from Modrinth.</p><button class="mod-inline-link" type="button" data-go-modrinth>Browse Modrinth →</button></div>`;
    list.querySelector('[data-go-modrinth]').onclick=()=>setModsTab('modrinth');
    return;
  }
  if(!assets.length){list.innerHTML='<div class="mod-empty-card"><span class="mod-empty-icon">⌕</span><h3>No installed items match this search.</h3><p>Change the search or clear it to see all installed content.</p></div>';return;}
  list.innerHTML=assets.map(asset=>{
    const label=assetType==='resourcepack'?'Resource pack':'Shader pack';
    const size=asset.size?`${(asset.size/1024/1024).toFixed(1)} MB`:'';
    const fallback=assetType==='resourcepack'?'▧':'✧';
    const icon=asset.icon?`<img src="${escapeHtml(asset.icon)}" alt="" onerror="this.hidden=true;this.nextElementSibling.hidden=false"><span class="mod-icon-fallback" hidden>${fallback}</span>`:`<span>${fallback}</span>`;
    const builtIn=asset.builtIn?'<span class="mod-built-in">Built-in</span>':'';
    const remove=asset.builtIn?'':`<button class="mod-action-button remove" type="button" data-asset-remove="${escapeHtml(assetType)}" data-file-name="${escapeHtml(asset.fileName)}" data-asset-name="${escapeHtml(asset.name)}" data-is-directory="${Boolean(asset.isDirectory)}">Remove</button>`;
    return `<article class="mod-card installed-asset-card"><div class="mod-card-icon asset-icon${asset.icon?'':' no-mod-icon'}">${icon}</div><div class="mod-card-copy"><div class="mod-card-title-row"><h3>${escapeHtml(asset.name)}</h3><span class="mod-platform-tag">${label}</span>${builtIn}</div><p>${escapeHtml(asset.description||'No description is available.')}</p><div class="mod-card-meta">${size?`<span>${size}</span>`:''}<code>${escapeHtml(asset.fileName)}</code></div></div>${remove}</article>`;
  }).join('');
}

function handleInstalledAssetAction(event){
  const button=event.target.closest('[data-asset-remove]');
  if(!button||button.disabled)return;
  const assetType=button.dataset.assetRemove;
  const name=button.dataset.assetName;
  removeModTarget={folder:$('#modInstance').value,fileName:button.dataset.fileName,name,assetType};
  $('#removeModTitle').textContent=`Remove this ${assetType==='resourcepack'?'resource pack':'shader pack'}?`;
  $('#removeModDescription').textContent=`This removes ${name} from the selected instance. Its ${button.dataset.isDirectory==='true'?'folder':'ZIP file'} will be deleted.`;
  $('#removeModCancel').textContent='Keep it';
  $('#removeModConfirm').textContent='Remove';
  $('#removeModError').hidden=true;
  $('#removeModDialog').hidden=false;
  $('#removeModCancel').focus();
}

function renderFilteredInstalledMods(){
  const list=$('#modList');
  if(!list||activeModsCategory!=='mods'||activeModsTab!=='installed')return;
  const filtered=installedModsCache.filter(mod=>{
    const stateMatches=installedModFilter==='all'||(installedModFilter==='enabled'?mod.enabled:!mod.enabled);
    const haystack=`${mod.name||''} ${mod.id||''} ${mod.baseName||''} ${mod.description||''}`.toLocaleLowerCase();
    return stateMatches&&haystack.includes(installedModQuery);
  });
  if(!installedModsCache.length){
    const instance=instances.find(item=>item.folder===$('#modInstance').value);
    if(instance?.installed===false)list.innerHTML=`<div class="mod-empty-card"><span class="mod-empty-icon">↓</span><h3>${escapeHtml(instance.name||instance.folder)} isn’t installed</h3><p>Install the instance from Home first. Once it’s ready, its mods will appear here.</p></div>`;
    else {list.innerHTML='<div class="mod-empty-card"><span class="mod-empty-icon">✣</span><h3>No mods found</h3><p>This instance’s mods folder is empty. Find compatible mods in the Modrinth tab.</p><button class="mod-inline-link" type="button" data-go-modrinth>Browse Modrinth →</button></div>';list.querySelector('[data-go-modrinth]').onclick=()=>setModsTab('modrinth');}
    return;
  }
  if(!filtered.length){
    const message=installedModQuery?'No installed mods match this search.':`No ${installedModFilter} mods in this instance.`;
    list.innerHTML=`<div class="mod-empty-card"><span class="mod-empty-icon">⌕</span><h3>${escapeHtml(message)}</h3><p>Change the search or choose another filter.</p></div>`;
    return;
  }
  list.innerHTML=filtered.map(renderInstalledModCard).join('');
}

function renderInstalledModCard(mod){
  const initial=escapeHtml((mod.name||'?').slice(0,1).toUpperCase());
  const icon=mod.icon?`<img src="${escapeHtml(mod.icon)}" alt="" onerror="this.hidden=true;this.nextElementSibling.hidden=false"><span class="mod-icon-fallback" hidden>${initial}</span>`:`<span>${initial}</span>`;
  const status=mod.enabled?'<span class="mod-state enabled">Enabled</span>':'<span class="mod-state disabled">Disabled</span>';
  const sourceTag=mod.modrinthProjectId?'<span class="mod-source-tag">Installed from Modrinth</span>':mod.builtIn?'':'<span class="mod-source-tag manual">Added manually</span>';
  const toggleLabel=`${mod.enabled?'Disable':'Enable'} ${mod.name}`;
  const actions=mod.protectedBuiltIn?'':`<button class="mod-toggle-switch${mod.enabled?' is-on':''}" type="button" role="switch" aria-checked="${Boolean(mod.enabled)}" aria-label="${escapeHtml(toggleLabel)}" title="${escapeHtml(toggleLabel)}" data-mod-action="toggle" data-file-name="${escapeHtml(mod.fileName)}" data-enabled="${Boolean(mod.enabled)}" ${modInstallBusy?'disabled':''}><span aria-hidden="true"></span></button><button class="mod-action-button remove" type="button" data-mod-action="remove" data-file-name="${escapeHtml(mod.fileName)}" data-mod-name="${escapeHtml(mod.name)}" ${modInstallBusy?'disabled':''}>Remove</button>`;
  return `<article class="mod-card installed-mod-card"><div class="mod-card-icon${mod.icon?'':' no-mod-icon'}">${icon}</div><div class="mod-card-copy"><div class="mod-card-title-row"><h3>${escapeHtml(mod.name)}</h3>${mod.builtIn?'<span class="mod-built-in">Built-in</span>':''}${sourceTag}${status}</div><p>${escapeHtml(mod.description)}</p><div class="mod-card-meta">${mod.version?`<span>v${escapeHtml(mod.version)}</span>`:''}<code>${escapeHtml(mod.id||mod.baseName)}</code></div></div><div class="mod-card-actions">${actions}</div></article>`;
}

async function handleInstalledModAction(event){
  const button=event.target.closest('[data-mod-action]');
  if(!button||button.disabled)return;
  const folder=$('#modInstance').value;
  if(button.dataset.modAction==='remove'){
    removeModTarget={folder,fileName:button.dataset.fileName,name:button.dataset.modName};
    $('#removeModTitle').textContent='Remove this mod?';
    $('#removeModDescription').textContent=`This removes ${removeModTarget.name} from the selected instance. Its JAR file will be deleted.`;
    $('#removeModCancel').textContent='Keep mod';
    $('#removeModConfirm').textContent='Remove mod';
    $('#removeModError').hidden=true;
    $('#removeModDialog').hidden=false;
    $('#removeModCancel').focus();
    return;
  }
  button.disabled=true;
  try{
    const result=await window.eclipse.mods.setEnabled(folder,button.dataset.fileName,button.dataset.enabled!=='true');
    installedModsCache=result.mods;
    updateAssetCounts();
    renderFilteredInstalledMods();
  }catch(error){showInstanceNotice(`Could not change mod state: ${error.message}`);button.disabled=false;}
}

function closeRemoveModDialog(){
  $('#removeModDialog').hidden=true;
  removeModTarget=null;
}

async function confirmRemoveMod(){
  if(!removeModTarget)return;
  const target=removeModTarget;
  const button=$('#removeModConfirm');
  button.disabled=true;
  try{
    const result=target.assetType
      ?await window.eclipse.mods.removeAsset(target.folder,target.fileName,target.assetType)
      :await window.eclipse.mods.remove(target.folder,target.fileName);
    closeRemoveModDialog();
    if(target.assetType){
      installedAssetCaches[target.assetType]=result.assets||[];
      installedAssetCacheFolders[target.assetType]=target.folder;
      updateAssetCounts();
      renderInstalledAssets(target.assetType,result.installed);
    }else{
      installedModsCache=result.mods;
      updateAssetCounts();
      renderFilteredInstalledMods();
    }
  }catch(error){$('#removeModError').textContent=error.message;$('#removeModError').hidden=false;}
  finally{button.disabled=false;}
}

async function searchModrinth(){
  const query=$('#modSearch').value.trim();
  if(!query){await loadModDiscovery();return;}
  const folder=$('#modInstance').value;
  const message=$('#modSearchMessage');
  const results=$('#modResults');
  $('#modDiscoverySentinel').hidden=true;
  if(activeModsCategory==='mods'&&String(instances.find(item=>item.folder===folder)?.loader||'').toLowerCase()==='vanilla'){
    message.textContent='Mods require a Fabric or Forge instance.';
    results.innerHTML='<div class="mod-empty-card"><span class="mod-empty-icon">ⓘ</span><h3>Vanilla instances do not support mods</h3><p>Choose a Fabric or Forge instance to browse compatible mods.</p></div>';
    return;
  }
  const requestId=++modSearchRequestId;
  lastModrinthProjects=[];
  const categoryLabel=activeModsCategory==='mods'?'mods':activeModsCategory==='resourcepack'?'resource packs':'shaders';
  const selectedLoader=instances.find(item=>item.folder===folder)?.loader||'Fabric';
  message.textContent=`Searching compatible ${categoryLabel}${activeModsCategory==='mods'?` for ${selectedLoader}`:''}…`;
  results.innerHTML=`<div class="mod-empty-card mod-loading"><span class="mod-spinner"></span>Finding ${categoryLabel} for this Minecraft version…</div>`;
  try{
    const response=await window.eclipse.mods.search(folder,query,{assetType:currentModrinthAssetType()});
    if(requestId!==modSearchRequestId)return;
    lastModrinthProjects=response.projects;
    lastModrinthInstanceInstalled=response.installed;
    const instance=instances.find(item=>item.folder===folder);
    const minecraftVersion=instance?.version||'this version';
    const loader=instance?.loader||'Fabric';
    message.textContent=`${response.projects.length} compatible ${categoryLabel} result${response.projects.length===1?'':'s'} for Minecraft ${minecraftVersion}${activeModsCategory==='mods'?` · ${loader}`:''}${response.installed?'':' · install the instance before adding content'}.`;
    renderModrinthResults();
  }catch(error){
    if(requestId!==modSearchRequestId)return;
    message.textContent=`Modrinth search failed: ${error.message}`;
    results.innerHTML='<div class="mod-empty-card mod-error"><h3>Couldn’t reach Modrinth</h3><p>Check your connection and try the search again.</p><button class="mod-inline-link" type="button" data-search-retry>Retry search</button></div>';
    results.querySelector('[data-search-retry]').onclick=searchModrinth;
  }
}

function modDiscoveryContextKey(){
  const instance=instances.find(item=>item.folder===$('#modInstance').value);
  return instance?`${activeModsCategory}:${instance.folder}:${instance.version||''}:${String(instance.loader||'').toLowerCase()}`:'';
}

function currentModrinthAssetType(){
  return activeModsCategory==='mods'?'mod':activeModsCategory;
}

async function loadModDiscovery(reset=false){
  if($('#modSearch').value.trim())return;
  const folder=$('#modInstance').value;
  const instance=instances.find(item=>item.folder===folder);
  const key=modDiscoveryContextKey();
  const results=$('#modResults');
  const sentinel=$('#modDiscoverySentinel');
  const sentinelLabel=$('#modDiscoverySentinelLabel');
  const loadMore=$('#modDiscoveryLoadMore');
  if(reset||key!==modDiscoveryKey){
    modDiscoveryRequestId++;
    modDiscoveryLoading=false;
    modDiscoveryProjects=[];
    modDiscoveryOffset=0;
    modDiscoveryTotalHits=0;
    modDiscoveryExhausted=false;
    modDiscoveryKey=key;
    results.innerHTML='';
  }
  if(activeModsTab!=='modrinth')return;
  if(!instance){
    sentinel.hidden=true;
    $('#modSearchMessage').textContent='Choose an instance to discover compatible mods.';
    results.innerHTML='<div class="mod-empty-card">Choose an instance to discover compatible mods.</div>';
    return;
  }
  if(activeModsCategory==='mods'&&String(instance.loader||'').toLowerCase()==='vanilla'){
    sentinel.hidden=true;
    $('#modSearchMessage').textContent='Mods require a Fabric or Forge instance.';
    results.innerHTML='<div class="mod-empty-card"><span class="mod-empty-icon">ⓘ</span><h3>Vanilla instances do not support mods</h3><p>Choose a Fabric or Forge instance to browse compatible mods.</p></div>';
    return;
  }
  if(modDiscoveryLoading||modDiscoveryExhausted)return;
  const requestId=++modDiscoveryRequestId;
  modDiscoveryLoading=true;
  loadMore.disabled=true;
  loadMore.textContent='Loading…';
  sentinel.hidden=false;
  sentinelLabel.textContent=modDiscoveryProjects.length?'Loading 4 more compatible mods…':'Finding popular compatible mods…';
  if(!modDiscoveryProjects.length)results.innerHTML='<div class="mod-empty-card mod-loading"><span class="mod-spinner"></span>Finding mods for this Minecraft version…</div>';
  try{
    const response=await window.eclipse.mods.search(folder,'',{assetType:currentModrinthAssetType(),discovery:true,offset:modDiscoveryOffset});
    if(requestId!==modDiscoveryRequestId||folder!==$('#modInstance').value||key!==modDiscoveryContextKey()||$('#modSearch').value.trim()||activeModsTab!=='modrinth')return;
    lastModrinthInstanceInstalled=response.installed;
    const known=new Set(modDiscoveryProjects.map(project=>project.id));
    modDiscoveryProjects.push(...response.projects.filter(project=>!known.has(project.id)));
    modDiscoveryOffset=response.offset+response.projects.length;
    modDiscoveryTotalHits=response.totalHits;
    modDiscoveryExhausted=response.projects.length<4||modDiscoveryOffset>=modDiscoveryTotalHits;
    renderModDiscoveryResults();
    const loader=instance.loader||'Fabric';
    const categoryLabel=activeModsCategory==='resourcepack'?'resource packs':activeModsCategory==='shader'?'shaders':'mods';
    $('#modSearchMessage').textContent=modDiscoveryProjects.length
      ?`Popular ${categoryLabel} compatible with Minecraft ${instance.version||'this version'}${activeModsCategory==='mods'?` · ${loader}`:''}. Scroll down or load 4 more.`
      :`No compatible ${categoryLabel} were found for this Minecraft version${activeModsCategory==='mods'?` and ${loader}`:''}.`;
    sentinel.hidden=modDiscoveryExhausted;
    sentinelLabel.textContent='Scroll down to load 4 more compatible mods.';
    loadMore.textContent='Load 4 more';
  }catch(error){
    if(requestId!==modDiscoveryRequestId||folder!==$('#modInstance').value)return;
    $('#modSearchMessage').textContent=`Modrinth discovery failed: ${error.message}`;
    if(modDiscoveryProjects.length){
      renderModDiscoveryResults();
      sentinel.hidden=false;
      sentinelLabel.textContent='Couldn’t load more mods. Try again.';
      loadMore.textContent='Retry';
    }else{
      sentinel.hidden=true;
      results.innerHTML='<div class="mod-empty-card mod-error"><h3>Couldn’t reach Modrinth</h3><p>Check your connection and try again.</p><button class="mod-inline-link" type="button" data-discovery-retry>Retry discovery</button></div>';
      results.querySelector('[data-discovery-retry]').onclick=()=>loadModDiscovery(true);
    }
  }finally{
    if(requestId===modDiscoveryRequestId){
      modDiscoveryLoading=false;
      loadMore.disabled=false;
    }
  }
}

function renderModDiscoveryResults(){
  const results=$('#modResults');
  if(!results)return;
  if(!modDiscoveryProjects.length&&modDiscoveryLoading){
    const label=activeModsCategory==='resourcepack'?'resource packs':activeModsCategory==='shader'?'shaders':'mods';
    results.innerHTML=`<div class="mod-empty-card mod-loading"><span class="mod-spinner"></span>Finding ${label} for this Minecraft version…</div>`;
    return;
  }
  results.innerHTML=modDiscoveryProjects.length
    ?modDiscoveryProjects.map(project=>renderModrinthCard(project,lastModrinthInstanceInstalled)).join('')
    :`<div class="mod-empty-card"><h3>No compatible discovery ${activeModsCategory==='resourcepack'?'resource packs':activeModsCategory==='shader'?'shaders':'mods'} found</h3><p>Try searching by name.</p></div>`;
}

function renderCurrentModrinthView(){
  if($('#modSearch').value.trim())renderModrinthResults();
  else renderModDiscoveryResults();
}

function renderModrinthResults(){
  $('#modDiscoverySentinel').hidden=true;
  const results=$('#modResults');
  if(!results||!lastModrinthProjects.length){
    if(results&&$('#modSearchMessage').textContent.includes('compatible'))results.innerHTML=`<div class="mod-empty-card"><h3>No compatible ${activeModsCategory==='resourcepack'?'resource packs':activeModsCategory==='shader'?'shaders':'mods'} found</h3><p>Try a different search, or check the spelling.</p></div>`;
    return;
  }
  results.innerHTML=lastModrinthProjects.map(project=>renderModrinthCard(project,lastModrinthInstanceInstalled)).join('');
}

function renderModrinthCard(project,instanceInstalled){
  const initial=escapeHtml((project.title||'?').slice(0,1).toUpperCase());
  const icon=project.icon?`<img src="${escapeHtml(project.icon)}" alt="" onerror="this.hidden=true;this.nextElementSibling.hidden=false"><span class="mod-icon-fallback" hidden>${initial}</span>`:`<span>${initial}</span>`;
  const downloads=Intl.NumberFormat().format(project.downloads);
  const loader=instances.find(item=>item.folder===$('#modInstance').value)?.loader||'Fabric';
  const isMod=activeModsCategory==='mods';
  const assetType=isMod?'':activeModsCategory;
  const installedAssets=assetType?installedAssetCaches[assetType]:[];
  const alreadyInstalled=isMod?installedModsCache.some(mod=>{
    const ids=[mod.id,mod.name,mod.modrinthSlug,mod.baseName?.replace(/\.jar(?:\.disabled)?$/i,'')].map(modIdentity);
    const projectIds=[project.slug,project.title].map(modIdentity);
    return mod.modrinthProjectId===project.id||projectIds.some(id=>id&&ids.includes(id));
  }):installedAssets.some(asset=>asset.projectId===project.id||modIdentity(asset.slug)===modIdentity(project.slug)||modIdentity(asset.fileName?.replace(/\.zip$/i,''))===modIdentity(project.slug));
  const disabled=alreadyInstalled||!instanceInstalled||modInstallBusy;
  const inventoryPending=isMod?installedModsCacheFolder!==$('#modInstance').value&&!installedModsCacheFailed:installedAssetCacheFolders[assetType]!==$('#modInstance').value&&!installedAssetCacheFailed[assetType];
  const inventoryFailed=isMod?installedModsCacheFailed&&installedModsCacheFolder!==$('#modInstance').value:installedAssetCacheFailed[assetType]&&installedAssetCacheFolders[assetType]!==$('#modInstance').value;
  const label=alreadyInstalled?'Installed':modInstallBusy?'Installing…':inventoryPending?'Checking installed…':inventoryFailed?'Could not verify':instanceInstalled?'Install':'Install instance first';
  const typeLabel=isMod?loader:assetType==='resourcepack'?'Resource pack':'Shader';
  const projectAction=isMod?`data-project-id="${escapeHtml(project.id)}"`:`data-asset-project-id="${escapeHtml(project.id)}" data-asset-type="${assetType}"`;
  return `<article class="mod-card modrinth-mod-card"><div class="mod-card-icon modrinth-icon${project.icon?'':' no-mod-icon'}">${icon}</div><div class="mod-card-copy"><div class="mod-card-title-row"><h3>${escapeHtml(project.title)}</h3><span class="mod-platform-tag">${escapeHtml(typeLabel)}</span></div><p>${escapeHtml(project.description)}</p><div class="mod-card-meta"><span>↓ ${downloads} downloads</span>${project.slug?`<code>${escapeHtml(project.slug)}</code>`:''}</div></div><button class="mod-install-button${alreadyInstalled?' already-installed':''}" type="button" ${projectAction} ${disabled||inventoryPending||inventoryFailed?'disabled':''}>${label}</button></article>`;
}

function modIdentity(value){
  // Built-in pack filenames often append version/loader text to the mod ID,
  // e.g. entity_texture_features-7.2.4-26.2-fabric. Strip that suffix so the
  // installed JAR matches Modrinth's shorter `entitytexturefeatures` slug.
  return String(value||'').toLowerCase().replace(/\.jar(?:\.disabled)?$/i,'').replace(/[^a-z0-9]/g,'').replace(/[0-9].*$/,'');
}

async function handleModrinthAction(event){
  const button=event.target.closest('[data-project-id],[data-asset-project-id]');
  if(!button||button.disabled||modInstallBusy)return;
  const folder=$('#modInstance').value;
  const assetType=button.dataset.assetType||'';
  const category=activeModsCategory;
  const projectId=assetType?button.dataset.assetProjectId:button.dataset.projectId;
  modInstallBusy=true;
  clearTimeout(modProgressDismissTimer);
  $$('#modResults [data-project-id], #modResults [data-asset-project-id]').forEach(item=>{item.disabled=true;item.textContent='Installing…';});
  $('#modInstallProgress').hidden=false;
  $('#modInstallProgress').classList.remove('error','complete');
  $('#modInstallProgressLabel').textContent=assetType?`Checking compatible ${assetType==='resourcepack'?'resource pack':'shader'} version…`:'Checking mod version and required dependencies…';
  $('#modInstallProgressPercent').textContent='';
  $('#modInstallProgressFill').style.width='4%';
  try{
    const result=assetType
      ?await window.eclipse.mods.installAsset(folder,projectId,assetType)
      :await window.eclipse.mods.install(folder,projectId);
    if(folder===$('#modInstance').value){
      const installedCount=result.installedCount||0;
      $('#modInstallProgressLabel').textContent=assetType
        ?installedCount?`${assetType==='resourcepack'?'Resource pack':'Shader pack'} installed`:'This asset is already installed'
        :installedCount?`Installed ${installedCount} mod${installedCount===1?'':'s'} including required dependencies`:'All required mods were already installed';
      $('#modInstallProgressPercent').textContent='Done';
      $('#modInstallProgressFill').style.width='100%';
      $('#modInstallProgress').classList.add('complete');
      if(assetType)await refreshInstalledAssets(assetType);
      else await refreshInstalledMods();
      modProgressDismissTimer=setTimeout(()=>{$('#modInstallProgress').hidden=true;},1000);
      showInstanceNotice(assetType
        ?installedCount?`${assetType==='resourcepack'?'Resource pack':'Shader pack'} installed successfully.`:'This asset is already installed.'
        :installedCount?'Mod and required dependencies installed successfully.':'This mod and its required dependencies are already installed.');
    }
  }catch(error){
    if(folder===$('#modInstance').value){
      $('#modInstallProgress').classList.add('error');
      $('#modInstallProgressLabel').textContent=error.message||'Mod installation failed.';
      $('#modInstallProgressPercent').textContent='';
      showInstanceNotice(`Could not install ${assetType==='resourcepack'?'resource pack':assetType==='shader'?'shader pack':'mod'}: ${error.message}`);
    }
  }finally{
    modInstallBusy=false;
    if(folder===$('#modInstance').value&&activeModsTab==='modrinth')await searchModrinthAfterInstall(folder,category);
    if(activeModsTab==='installed'&&folder===$('#modInstance').value)refreshCurrentInstalledContent();
  }
}

async function searchModrinthAfterInstall(folder,category){
  if(activeModsTab!=='modrinth'||folder!==$('#modInstance').value||activeModsCategory!==category)return;
  if($('#modSearch').value.trim())await searchModrinth();
  else renderModDiscoveryResults();
}

function updateModInstallProgress(progress){
  if(progress.folder!==$('#modInstance').value)return;
  const panel=$('#modInstallProgress');
  panel.hidden=false;
  panel.classList.toggle('error',Boolean(progress.error));
  panel.classList.toggle('complete',Boolean(progress.complete));
  $('#modInstallProgressLabel').textContent=progress.status||'Installing mods…';
  $('#modInstallProgressPercent').textContent=Number.isFinite(progress.percent)?`${progress.percent}%`:'';
  if(Number.isFinite(progress.percent))$('#modInstallProgressFill').style.width=`${Math.max(0,Math.min(100,progress.percent))}%`;
}

function applySettings(s){
  const name=s.profile?.name||'Steve';
  $('#accountName').textContent=name;
  const crown=name==='Arman_Legend'?'<svg class="name-crown" viewBox="0 0 20 18" aria-label="Crown" role="img"><path d="M2 6.5 5.2 9l2-5 2.8 4.2L12.8 4l2 5L18 6.5l-1.7 8H3.7L2 6.5Z"/><path d="M4.5 17h11"/></svg>':'';
  $('#heroName').innerHTML=escapeHtml(name)+crown;
  hydrateSkinHead($('#avatar'),s.profile?.id,name);
  if(s.backgroundUrl){
    setBackgroundImage(s.backgroundUrl);
  } else if(s.background) {
    const url = localFileUrl(s.background);
    setBackgroundImage(url);
  }
  $('#theme').value=s.theme||'dark';
  syncCustomDropdown('theme');
  $('#animationSpeed').value=s.animationSpeed||'normal';
  syncCustomDropdown('animationSpeed');
  setAnimationSpeed(s.animationSpeed||'normal');
  $('#playAnimationSpeed').value=s.playAnimationSpeed||'relaxed';
  syncCustomDropdown('playAnimationSpeed');
  setPlayAnimationSpeed(s.playAnimationSpeed||'relaxed');
  showPlaytime=s.showPlaytime!==false;
  $('#showPlaytimeToggle').checked=showPlaytime;
  playtimePosition=s.playtimePosition==='right'?'right':'left';
  $('#playtimePosition').value=playtimePosition;
  syncCustomDropdown('playtimePosition');
  $('.selected-instance-bar').classList.toggle('playtime-right',playtimePosition==='right');
  newsEnabled=s.newsEnabled!==false;
  $('#newsEnabledToggle').checked=newsEnabled;
  $('#newsSection').hidden=!newsEnabled;
  $('#showFriendsBoxToggle').checked=s.showFriendsBox!==false;
  $('#friendsBox').hidden=s.showFriendsBox===false;
  $('#showQuickLaunchToggle').checked=s.showQuickLaunch!==false;
  $('#quickLaunchPanel').hidden=s.showQuickLaunch===false;
  applySidebarOrder(s.sidebarOrder||sidebarOrder);
  document.body.classList.toggle('light',s.theme==='light');
  if(currentBackgroundImageUrl)setBackgroundImage(currentBackgroundImageUrl);
  if(s.profile?.status) updateStatusUI(s.profile.status);
}

function renderProfiles(settings){
  profiles=settings.profiles||[];
  selectedProfileId=settings.selectedProfileId||settings.profile?.id||null;
  $('#profileList').innerHTML=profiles.map(profile=>{
    const selected=profile.id===selectedProfileId;
    const isMicrosoft=profile.type==='microsoft';
    return `<button class="profile-choice${selected?' selected':''}" data-profile-id="${escapeHtml(profile.id)}" aria-pressed="${selected}">
      ${skinHeadMarkup(profile.name,`profile-avatar ${isMicrosoft?'microsoft':''}`)}
      <span class="profile-choice-copy"><b>${escapeHtml(profile.name)}</b><small>${isMicrosoft?'Microsoft account':'Offline profile'}</small></span>
      <span class="profile-choice-check">${selected?'✓':'›'}</span>
    </button>`;
  }).join('');
  $$('.profile-choice .skin-head').forEach((head,index)=>hydrateSkinHead(head,profiles[index]?.id,profiles[index]?.name));
  $$('.profile-choice').forEach(button=>button.onclick=async()=>{
    try{
      const updated=await window.eclipse.accounts.select(button.dataset.profileId);
      renderProfiles(updated);
      applySettings(updated);
    }catch(error){showAccountMessage(error.message,true);}
  });
  const selected=profiles.find(profile=>profile.id===selectedProfileId);
  $('#selectedProfileDetails').innerHTML=selected?`<div class="selected-profile-card">
    ${skinHeadMarkup(selected.name,`profile-avatar large ${selected.type==='microsoft'?'microsoft':''}`)}
    <div class="selected-profile-copy"><span class="tag">${selected.type==='microsoft'?'MICROSOFT ACCOUNT':'OFFLINE PROFILE'}</span><h2>${escapeHtml(selected.name)}</h2><p>${selected.type==='microsoft'?'This Microsoft account is selected for Minecraft launches.':'This local player profile is selected for Minecraft launches.'}</p></div>
    ${profiles.length>1?`<button class="remove-profile-button" id="removeSelectedProfile">Remove</button>`:''}
  </div>
  <div class="profile-tools-grid">
    <section class="profile-tool-card notes-card"><div class="profile-tool-heading"><div><h3>Account notes</h3><small>Saved with this profile on this device</small></div><span id="noteSaveState">Saved</span></div>
      <div class="note-toolbar" role="toolbar" aria-label="Format account note">
        <button type="button" data-note-command="bold" aria-label="Bold" title="Bold"><b>B</b></button>
        <button type="button" data-note-command="italic" aria-label="Italic" title="Italic"><i>I</i></button>
        <button type="button" data-note-command="underline" aria-label="Underline" title="Underline"><u>U</u></button>
        <label class="note-color-control" for="noteTextColor" title="Text color"><span>A</span><input type="color" id="noteTextColor" value="#d9c7ff" aria-label="Text color"></label>
      </div>
      <div id="profileNote" class="note-editor" contenteditable="true" role="textbox" aria-multiline="true" aria-label="Account notes" spellcheck="false" autocorrect="off" autocapitalize="off" autocomplete="off" data-placeholder="Keep a note for ${escapeHtml(selected.name)}…"></div>
    </section>
    <section class="profile-tool-card skin-card"><div class="profile-tool-heading"><div><h3>Skin viewer</h3><small>Ely.by and official Minecraft skins</small></div><button id="downloadSkin" class="skin-download-button" title="Download this skin" aria-label="Download this skin">↓</button></div>
      <div class="skin-viewer-content"><div class="skin-assets-column">${skinHeadMarkup(selected.name,'skin-viewer-head')}<div class="skin-texture-wrap"><span class="skin-texture-label">Full skin texture</span><div class="skin-texture-frame"><img id="skinTexturePreview" alt="${escapeHtml(selected.name)} Minecraft skin texture"><span id="skinMessage">Looking for this skin…</span></div></div></div><div class="skin-3d-wrap"><span class="skin-texture-label">3D preview · drag to rotate</span><canvas id="skin3dCanvas" aria-label="3D preview of ${escapeHtml(selected.name)}'s Minecraft skin"></canvas></div></div>
    </section>
  </div>`:'';
  if(selected){
    const noteEditor=$('#profileNote');
    noteEditor.innerHTML=selected.noteFormat==='html-v1'
      ? sanitizeNoteHtml(selected.note||'')
      : plainTextToNoteHtml(selected.note||'');
    attachNoteEditor(noteEditor,selected.id);
    const head=$('#selectedProfileDetails .selected-profile-card .skin-head');
    const viewerHead=$('#selectedProfileDetails .skin-viewer-head');
    const texture=$('#skinTexturePreview');
    const message=$('#skinMessage');
    const canvas=$('#skin3dCanvas');
    hydrateSkinHead(head,selected.id,selected.name);
    hydrateSkinHead(viewerHead,selected.id,selected.name,texture,message);
    initializeSkinViewer(canvas,selected.id,message);
    $('#downloadSkin').onclick=async()=>{
      const button=$('#downloadSkin');
      button.disabled=true;
      message.textContent='Preparing skin download…';
      try{
        const savedPath=await window.eclipse.accounts.downloadSkin(selected.id);
        if(savedPath) message.textContent=`Skin saved to ${savedPath}`;
        else message.textContent='Download cancelled.';
      }catch(error){message.textContent=error.message;}
      finally{button.disabled=false;}
    };
  }
  $('#removeSelectedProfile')?.addEventListener('click',async()=>{
    showRemoveProfileDialog(selected);
  });
}

function plainTextToNoteHtml(value){
  return escapeHtml(value).replace(/\r\n|\r|\n/g,'<br>');
}

function sanitizeNoteHtml(value){
  const template=document.createElement('template');
  template.innerHTML=String(value||'');
  const allowed=new Set(['B','STRONG','I','EM','U','BR','DIV','P','SPAN','FONT']);
  const scrub=parent=>{
    [...parent.childNodes].forEach(node=>{
      if(node.nodeType===Node.TEXT_NODE)return;
      if(node.nodeType!==Node.ELEMENT_NODE){node.remove();return;}
      const tag=node.tagName;
      if(!allowed.has(tag)){
        node.remove();
        return;
      }
      const rawColor=node.style.color||node.getAttribute('color')||'';
      const cleanColor=CSS.supports('color',rawColor)?rawColor:'';
      const styles=[];
      if(cleanColor)styles.push(`color:${cleanColor}`);
      if(['bold','600','700','800','900'].includes(node.style.fontWeight))styles.push('font-weight:bold');
      if(node.style.fontStyle==='italic')styles.push('font-style:italic');
      if((node.style.textDecorationLine||node.style.textDecoration||'').includes('underline'))styles.push('text-decoration:underline');
      const replacement=tag==='FONT'?document.createElement('span'):node;
      if(replacement!==node){node.replaceWith(replacement);replacement.append(...node.childNodes);}
      [...replacement.attributes].forEach(attribute=>replacement.removeAttribute(attribute.name));
      if(styles.length)replacement.setAttribute('style',styles.join(';'));
      scrub(replacement);
    });
  };
  scrub(template.content);
  return template.innerHTML;
}

function saveNoteSelection(editor){
  const selection=window.getSelection();
  if(selection?.rangeCount&&editor.contains(selection.anchorNode))noteSelectionRange=selection.getRangeAt(0).cloneRange();
}

function restoreNoteSelection(editor){
  editor.focus();
  if(!noteSelectionRange)return;
  const selection=window.getSelection();
  selection.removeAllRanges();
  selection.addRange(noteSelectionRange);
}

function attachNoteEditor(editor,profileId){
  const status=$('#noteSaveState');
  editor.addEventListener('keyup',()=>saveNoteSelection(editor));
  editor.addEventListener('mouseup',()=>saveNoteSelection(editor));
  editor.addEventListener('paste',event=>{
    event.preventDefault();
    document.execCommand('insertText',false,event.clipboardData.getData('text/plain'));
  });
  editor.addEventListener('input',()=>{
    saveNoteSelection(editor);
    status.textContent='Saving…';
    clearTimeout(noteSaveTimer);
    const note=sanitizeNoteHtml(editor.innerHTML);
    noteSaveTimer=setTimeout(async()=>{
      try{await window.eclipse.accounts.setNote(profileId,note);if(status.isConnected)status.textContent='Saved';}
      catch(error){if(status.isConnected)status.textContent='Could not save';showAccountMessage(error.message,true);}
    },450);
  });
  $$('[data-note-command]').forEach(button=>{
    button.addEventListener('mousedown',event=>event.preventDefault());
    button.addEventListener('click',()=>{
      restoreNoteSelection(editor);
      document.execCommand('styleWithCSS',false,true);
      document.execCommand(button.dataset.noteCommand,false,null);
      saveNoteSelection(editor);
      editor.dispatchEvent(new Event('input',{bubbles:true}));
    });
  });
  const colorPicker=$('#noteTextColor');
  colorPicker.addEventListener('mousedown',()=>saveNoteSelection(editor));
  colorPicker.addEventListener('change',()=>{
    restoreNoteSelection(editor);
    document.execCommand('styleWithCSS',false,true);
    document.execCommand('foreColor',false,colorPicker.value);
    saveNoteSelection(editor);
    editor.dispatchEvent(new Event('input',{bubbles:true}));
  });
}

function showRemoveProfileDialog(profile){
  removeProfileTarget=profile;
  $('#removeProfileName').textContent=profile.name;
  $('#removeProfileError').hidden=true;
  $('#removeProfileError').textContent='';
  const overlay=$('#removeProfileDialog');
  overlay.hidden=false;
  $('#removeProfileCancel').focus();
}

function closeRemoveProfileDialog(){
  $('#removeProfileDialog').hidden=true;
  removeProfileTarget=null;
}

function showRenameInstanceDialog(instance){
  renameInstanceTarget=instance;
  renameInstanceIcon=String(instance.icon||'');
  $('#renameInstanceInput').value=instance.name||instance.folder;
  $$('#renameInstanceIcons [data-icon]').forEach(button=>button.classList.toggle('active',button.dataset.icon===renameInstanceIcon));
  $('#renameInstanceError').hidden=true;
  $('#renameInstanceError').textContent='';
  $('#renameInstanceDialog').hidden=false;
  $('#renameInstanceInput').focus();
  $('#renameInstanceInput').select();
}

function closeRenameInstanceDialog(){
  $('#renameInstanceDialog').hidden=true;
  renameInstanceTarget=null;
  renameInstanceIcon='';
}

function showDeleteInstanceDialog(instance){
  deleteInstanceTarget=instance;
  deleteInstanceStage=1;
  $('#deleteInstanceFinalConfirm').textContent='Yes, delete everything';
  $('#deleteInstanceFinalConfirm').disabled=false;
  $('#deleteInstanceFinalCancel').disabled=false;
  if(instance.customInstance){
    $('#deleteInstanceTitle').textContent=instance.installed?'Delete this custom instance?':'Delete this custom instance?';
    $('#deleteInstanceDescription').textContent=instance.installed
      ? `This permanently deletes ${instance.name||instance.folder}, including its worlds, mods, settings, and downloaded files. This custom instance cannot be downloaded again.`
      : `This custom instance has not been installed yet. Deleting it will permanently remove it from Eclipse.`;
    $('#deleteInstanceConfirm').textContent=instance.installed?'Yes, delete this instance':'Yes, delete it';
  }else{
    $('#deleteInstanceTitle').textContent='Delete instance files?';
    $('#deleteInstanceDescription').innerHTML=`This will remove the worlds, resource packs, mods, settings, and other downloaded files for <b>${escapeHtml(instance.name||instance.folder)}</b>. You can install this instance again later. Eclipse will keep its instance profile file.`;
    $('#deleteInstanceConfirm').textContent='Yes, I want to delete';
  }
  $('#deleteInstanceError').hidden=true;
  $('#deleteInstanceError').textContent='';
  $('#deleteInstanceDialog').hidden=false;
  $('#deleteInstanceCancel').focus();
}

function closeDeleteInstanceDialog(){
  if(deletingInstance)return;
  $('#deleteInstanceDialog').hidden=true;
  $('#deleteInstanceFinalDialog').hidden=true;
  deleteInstanceTarget=null;
  deleteInstanceStage=1;
}

async function confirmDeleteInstance(){
  if(!deleteInstanceTarget)return;
  if(deleteInstanceStage===1){
    deleteInstanceStage=2;
    $('#deleteInstanceDialog').hidden=true;
    $('#deleteInstanceFinalDescription').textContent=deleteInstanceTarget.customInstance
      ? `This will permanently delete ${deleteInstanceTarget.name||deleteInstanceTarget.folder} and all of its files from this device. This custom instance cannot be downloaded again.`
      : `This will permanently remove every file in ${deleteInstanceTarget.name||deleteInstanceTarget.folder} except eclipse-instance.json. Your worlds and downloaded content cannot be recovered from this device. You can install the instance again later.`;
    $('#deleteInstanceFinalError').hidden=true;
    $('#deleteInstanceFinalError').textContent='';
    $('#deleteInstanceFinalDialog').hidden=false;
    $('#deleteInstanceFinalCancel').focus();
    return;
  }
}

async function performDeleteInstance(){
  if(!deleteInstanceTarget||deleteInstanceStage!==2)return;
  const target=deleteInstanceTarget;
  const cancel=$('#deleteInstanceFinalCancel');
  const confirm=$('#deleteInstanceFinalConfirm');
  cancel.disabled=true;
  confirm.disabled=true;
  deletingInstance=true;
  confirm.textContent='Deleting…';
  try{
    const result=await window.eclipse.instances.deleteFiles(target.folder);
    pinnedInstanceFolders=pinnedInstanceFolders.filter(folder=>folder!==target.folder);
    instances=await window.eclipse.instances.list();
    if(result.customInstanceDeleted){
      if(selectedInstanceFolder===target.folder)selectedInstanceFolder=null;
      if(savedModsInstanceFolder===target.folder)savedModsInstanceFolder='';
      setupModsPage();
      savedModsInstanceFolder=$('#modInstance').value;
      await window.eclipse.settings.set({modsInstanceFolder:savedModsInstanceFolder}).catch(()=>{});
      if($('#mods').classList.contains('active-page'))refreshCurrentInstalledContent();
    }
    deletingInstance=false;
    closeDeleteInstanceDialog();
    renderInstances();
    renderQuick();
    showInstanceNotice(result.customInstanceDeleted?`${target.name||target.folder} was permanently deleted.`:`${target.name||target.folder} files deleted. You can install this instance again anytime.`);
  }catch(error){
    $('#deleteInstanceFinalError').textContent=error.message;
    $('#deleteInstanceFinalError').hidden=false;
  }finally{
    deletingInstance=false;
    cancel.disabled=false;
    confirm.disabled=false;
    if(!$('#deleteInstanceFinalDialog').hidden)confirm.textContent='Yes, delete everything';
  }
}

function skinHeadMarkup(name,extraClass=''){
  const initial=escapeHtml((name||'?').slice(0,1).toUpperCase());
  return `<span class="skin-head ${extraClass}"><span class="skin-initial">${initial}</span><img class="skin-head-base" alt=""><img class="skin-head-hat" alt=""></span>`;
}

async function initializeSkinViewer(canvas,profileId,statusMessage){
  if(skinViewer){
    skinViewer.resizeObserver?.disconnect();
    skinViewer.viewer?.dispose();
    skinViewer=null;
  }
  if(!canvas||!window.skinview3d?.SkinViewer)return;
  try{
    let skinData=skinDataRequests.get(profileId);
    if(!skinData){
      skinData=window.eclipse.accounts.skinData(profileId).finally(()=>skinDataRequests.delete(profileId));
      skinDataRequests.set(profileId,skinData);
    }
    const dataUrl=await skinData;
    if(!canvas.isConnected)return;
    const viewer=new window.skinview3d.SkinViewer({canvas,width:220,height:220,skin:dataUrl,zoom:.72,background:0x0b1322,alpha:true,renderPaused:!canvas.closest('#profile')?.classList.contains('active-page')});
    viewer.playerWrapper.position.x=-7.5;
    viewer.autoRotate=true;
    const resize=()=>{
      if(!canvas.isConnected)return;
      const bounds=canvas.getBoundingClientRect();
      if(bounds.width<1||bounds.height<1)return;
      viewer.width=Math.round(bounds.width);
      viewer.height=Math.round(bounds.height);
    };
    const resizeObserver=new ResizeObserver(resize);
    resizeObserver.observe(canvas);
    resize();
    skinViewer={viewer,resizeObserver,profileId,resize};
  }catch(error){
    if(canvas.isConnected&&statusMessage){
      statusMessage.hidden=false;
      statusMessage.textContent=`3D preview unavailable: ${error.message}`;
    }
  }
}

async function hydrateSkinHead(head,profileId,name,textureImage=null,statusMessage=null){
  if(!head||!profileId)return;
  try{
    let lookup=skinUrlRequests.get(profileId);
    if(!lookup){
      lookup=window.eclipse.accounts.skinUrl(profileId).finally(()=>skinUrlRequests.delete(profileId));
      skinUrlRequests.set(profileId,lookup);
    }
    const url=await lookup;
    if(!head.isConnected)return;
    if(!url)throw new Error(`No Ely.by or Minecraft skin found for ${name}.`);
    const base=head.querySelector('.skin-head-base');
    const hat=head.querySelector('.skin-head-hat');
    base.onload=()=>head.classList.add('has-skin');
    base.onerror=()=>head.classList.add('skin-missing');
    base.src=url;
    hat.src=url;
    if(textureImage){
      textureImage.onload=()=>{textureImage.classList.add('loaded');if(statusMessage)statusMessage.hidden=true;};
      textureImage.onerror=()=>{if(statusMessage)statusMessage.textContent=`No skin texture available for ${name}.`;};
      textureImage.src=url;
    }
  }catch(error){
    if(head.isConnected)head.classList.add('skin-missing');
    if(statusMessage)statusMessage.textContent=error.message;
  }
}

function showAccountMessage(message,isError=false){
  const node=$('#accountSetupMessage');
  node.textContent=message||'';
  node.classList.toggle('error',Boolean(isError));
}

function setAccountType(type){
  $$('[data-account-type]').forEach(button=>button.classList.toggle('active',button.dataset.accountType===type));
  $('#offlineAccountForm').hidden=type!=='offline';
  $('#microsoftAccountForm').hidden=type!=='microsoft';
  showAccountMessage('');
}

function localFileUrl(filePath){
  const normalized=String(filePath).replaceAll('\\','/');
  if(/^[A-Za-z]:\//.test(normalized)) return 'file:///'+encodeURI(normalized);
  if(normalized.startsWith('/')) return 'file://'+encodeURI(normalized);
  return normalized;
}

function setBackgroundImage(url){
  currentBackgroundImageUrl=url;
  const hero=$('.hero');
  const imageLayer=`url("${url.replaceAll('"','%22')}")`;
  hero.style.setProperty('--eclipse-custom-background',imageLayer);
  const overlay=document.body.classList.contains('light')
    ?'linear-gradient(90deg,rgba(7,10,22,.45),rgba(7,10,22,.08))'
    :'linear-gradient(90deg,rgba(7,10,22,.22),rgba(7,10,22,.08))';
  hero.style.backgroundImage=`${overlay},${imageLayer}`;
  hero.style.backgroundSize='cover, cover';
  hero.style.backgroundPosition='center, center';
  hero.style.backgroundRepeat='no-repeat, no-repeat';
  hero.classList.add('custom-background');
  $('#backgroundPreview').style.backgroundImage=`url("${url}")`;
}

function updateStatusUI(status){
  const safeStatus=['online','offline','dnd'].includes(status)?status:'online';
  const label={online:'Online',offline:'Offline',dnd:'Do Not Disturb'}[safeStatus];
  const dot=document.createElement('i');
  dot.className=`status-dot status-${safeStatus}`;
  dot.setAttribute('aria-hidden','true');
  $('#accountState').replaceChildren(dot,document.createTextNode(label));
}

function setAnimationSpeed(speed='normal'){
  pageAnimationDuration=animationDurations[speed]??animationDurations.normal;
  document.documentElement.style.setProperty('--page-animation-duration',`${pageAnimationDuration}ms`);
  document.documentElement.style.setProperty('--motion-transition-duration',`${speed==='off'?0:Math.round(pageAnimationDuration*.4)}ms`);
  return pageAnimationDuration;
}

function setPlayAnimationSpeed(speed='relaxed'){
  const duration=animationDurations[speed]??animationDurations.relaxed;
  document.documentElement.style.setProperty('--selected-play-duration',`${duration}ms`);
  return duration;
}

function applySidebarOrder(order){
  const pages=Object.keys(sidebarPageLabels);
  const requested=Array.isArray(order)?order.filter(page=>pages.includes(page)):[];
  sidebarOrder=[...new Set(requested),...pages.filter(page=>!requested.includes(page))];
  const nav=$('aside nav');
  sidebarOrder.forEach(page=>{
    const button=nav.querySelector(`[data-page="${page}"]`);
    if(button)nav.appendChild(button);
  });
  const list=$('#sidebarOrderList');
  if(!list)return;
  list.innerHTML=sidebarOrder.map((page,index)=>`<div class="sidebar-order-row"><span>${escapeHtml(sidebarPageLabels[page])}</span><div><button type="button" data-order-page="${page}" data-order-move="-1" aria-label="Move ${sidebarPageLabels[page]} up" title="Move up" ${index===0?'disabled':''}>↑</button><button type="button" data-order-page="${page}" data-order-move="1" aria-label="Move ${sidebarPageLabels[page]} down" title="Move down" ${index===sidebarOrder.length-1?'disabled':''}>↓</button></div></div>`).join('');
  $$('.sidebar-order-row button').forEach(button=>button.onclick=()=>moveSidebarPage(button.dataset.orderPage,Number(button.dataset.orderMove)));
}

function detectFabricModConflicts(log){
  const rootVersions=new Map();
  for(const match of log.matchAll(/ROOT_FORCELOAD_SINGLE\s+([^\s,]+)\s+([^\s,}\]]+)/gi))rootVersions.set(match[1].toLowerCase(),match[2].replace(/[!,;]+$/,''));
  const conflicts=[];
  const seen=new Set();
  const add=(firstName,firstId,firstVersion,secondName,secondId,secondVersion)=>{
    const key=[firstId,firstVersion,secondId,secondVersion].join('|').toLowerCase();
    if(seen.has(key))return;
    seen.add(key);
    conflicts.push({firstName:firstName||firstId,firstId,firstVersion,secondName:secondName||secondId,secondId,secondVersion});
  };
  const named=/Mod '([^']+)' \(([^)]+)\) ([^\s]+) is incompatible with any version of mod '([^']+)' \(([^)]+)\), yet a conflicting version is present: ([^!\s]+)!?/gi;
  for(const match of log.matchAll(named))add(match[1],match[2],match[3],match[4],match[5],match[6]);
  const raw=/NEG_HARD_DEP\s+([^\s,]+)\s+([^\s,]+)\s+\{breaks\s+([^\s@,]+)\s+@\s+\[\*\]\}/gi;
  for(const match of log.matchAll(raw))add('',match[1],match[2],'',match[3],rootVersions.get(match[3].toLowerCase())||'');
  return conflicts;
}

function removeOptionalMixinWarnings(log){
  const lines=String(log||'').split(/\r?\n/);
  return lines.filter(line=>{
    if(/@Mixin target .* was not found.*?\.mixins\.json/i.test(line))return false;
    // Fabric logs failed optional class probes at WARN level while mods check
    // whether integrations such as Mod Menu, JEI, or Starlight are installed.
    // A genuinely required class/mixin failure is reported separately as an
    // ERROR (or in a crash report), so these probes must not trigger a diagnosis.
    if(/\[.*\/WARN\].*Error loading class:\s*[\w/$.-]+.*ClassNotFoundException/i.test(line))return false;
    return true;
  }).join('\n');
}

function diagnoseLogText(text, source){
  let log=String(text||'');
  if(source==='launcher'){
    const attempts=[...log.matchAll(/\[Launch\]\s+Starting [^\r\n]*/g)];
    if(attempts.length)log=log.slice(attempts[attempts.length-1].index);
  }
  log=removeOptionalMixinWarnings(log);
  const conflicts=detectFabricModConflicts(log);
  if(conflicts.length){
    const descriptions=conflicts.map(item=>{
      const firstLabel=item.firstName.toLowerCase()===item.firstId.toLowerCase()?item.firstId:`${item.firstName} (${item.firstId})`;
      const secondLabel=item.secondName.toLowerCase()===item.secondId.toLowerCase()?item.secondId:`${item.secondName} (${item.secondId})`;
      return `• ${firstLabel} ${item.firstVersion} conflicts with ${secondLabel}${item.secondVersion?` ${item.secondVersion}`:''}.`;
    });
    const fixLine=log.split(/\r?\n/).find(line=>/\bFix:\s*(?:add|remove|replace)/i.test(line));
    return [{title:'Fabric identified conflicting mods',fix:`${descriptions.join('\n')}\nTry removing one of the listed mods, or update/downgrade one until the pair is compatible. The Minecraft version and Fabric Loader version must also match.`,evidence:fixLine?.trim().slice(0,500)||''}];
  }
  if(/Mod resolution failed|Incompatible mods found!/i.test(log)){
    return [{title:source==='launcher'?'Minecraft could not resolve its mod set':'Fabric could not resolve this mod set',fix:source==='launcher'?'This launcher log records a failed Minecraft start. Open the matching instance’s latest.log or crash report to see which exact mods conflict.':'The log confirms a mod-resolution failure but does not include a complete conflict pair. Check the nearby “Reason” and “Fix” lines, then remove or change one of the named mods.'}];
  }
  const rules=[
    {pattern:/MixinApplyError|MixinTransformerError|Critical injection failure|InjectionError/i,title:'A mod failed to apply its game changes',fix:'This usually means a mod is outdated or conflicts with another mod. Update the named mod and its dependencies, then remove or update other mods mentioned near this error.'},
    {pattern:/UnsupportedClassVersionError|class file version \d+\.\d+/i,title:'A mod requires a different Java version',fix:'Use the Java runtime recommended for this Minecraft version. Eclipse installs its runtime automatically; if you selected a custom Java executable, switch back to the installed runtime.'},
    {pattern:/OutOfMemoryError|Could not reserve enough space|GC overhead limit exceeded/i,title:'Minecraft ran out of memory',fix:'Close other memory-heavy apps and remove large or conflicting mods. If the problem continues, use a lighter mod set or allocate more memory to Minecraft.'},
    {pattern:/NoSuchMethodError|NoSuchFieldError|NoClassDefFoundError|ClassNotFoundException/i,title:'A mod or dependency is missing or incompatible',fix:'Update the named mod and its required dependencies for the exact Minecraft version and loader. If it began after adding a mod, remove that mod and try again.'},
    {pattern:/ModLoadingException|Failed to load mod|Error loading mods|Failed to load config/i,title:'A mod could not load',fix:'Look for the mod name on this line and nearby lines. Check that it matches this instance’s Minecraft version and loader, then update it or remove it.'},
    {pattern:/UnknownHostException|ConnectException|Connection timed out|Read timed out|Name or service not known|ENOTFOUND|ECONNRESET/i,title:'A network connection failed',fix:'Check your internet connection and try again. If this appears while joining a server, check that the server is online and reachable.'},
    {pattern:/ENOENT|The system cannot find the file specified|Could not find or load main class|Could not find main class/i,title:'A required file or Java executable is missing',fix:'Try installing the instance again. If Eclipse cannot find Java, close and reopen the launcher so it can repair the bundled runtime; check whether antivirus quarantined a game file.'},
    {pattern:/The game crashed whilst|Description:.*Exception|Exception in thread "main"/i,title:'Minecraft crashed during startup',fix:'Use the error lines below this message to identify the mod or runtime involved. Update or remove the named mod, then relaunch. If no mod is named, reinstall this instance.'}
  ];
  const findings=[];
  const lines=log.split(/\r?\n/);
  for(const rule of rules){
    const match=rule.pattern.exec(log);
    if(!match)continue;
    const line=log.slice(0,match.index).split(/\r?\n/).length;
    const evidence=lines.slice(Math.max(0,line-2),Math.min(lines.length,line+1)).join(' ').trim().slice(0,260);
    findings.push({title:rule.title,fix:rule.fix,evidence});
    if(findings.length>=4)break;
  }
  if(findings.length)return findings;
  if(!log.trim())return [{title:'No log content yet',fix:'Refresh after launching the game. Minecraft logs appear once that instance has started.',neutral:true}];
  if(source==='launcher'&&!/error|exception|failed|crash|fatal/i.test(log))return [{title:'No actionable launcher problem found',fix:'If Minecraft failed to start, select that instance’s latest.log or the newest crash report.',neutral:true}];
  return [{title:'No actionable issue detected',fix:'No recognized crash or launch failure was found in this log. Some Minecraft warnings are optional features or harmless notices; the log remains available below if you need to share it.',neutral:true}];
}

function renderLogDiagnosis(log){
  const findings=diagnoseLogText(log.text,log.source);
  $('#diagnosticFindings').innerHTML=findings.map(finding=>`<article class="diagnostic-finding${finding.neutral?' neutral':''}"><h3>${escapeHtml(finding.title)}</h3><p>${escapeHtml(finding.fix)}</p>${finding.evidence?`<div class="diagnostic-evidence">${escapeHtml(finding.evidence)}</div>`:''}</article>`).join('');
}

async function refreshDiagnosticLogs(preserveSelection=true){
  const select=$('#diagnosticLogSelect');
  const previous=preserveSelection?select.value:'';
  const refresh=$('#refreshDiagnosticLogs');
  refresh.disabled=true;
  $('#diagnosticLogStatus').textContent='Looking for launcher logs and Minecraft crash reports…';
  try{
    diagnosticLogEntries=await window.eclipse.diagnostics.list();
    select.replaceChildren();
    const menu=$('#diagnosticLogSelectMenu');
    menu.replaceChildren();
    if(!diagnosticLogEntries.length){
      const option=document.createElement('option');option.value='';option.textContent='No logs found';select.append(option);
      const menuOption=document.createElement('button');menuOption.type='button';menuOption.className='custom-select-option selected';menuOption.dataset.value='';menuOption.setAttribute('role','option');menuOption.setAttribute('aria-selected','true');menuOption.tabIndex=-1;menuOption.textContent='No logs found';menu.append(menuOption);
      $('#diagnosticLogSelectTrigger').disabled=true;
      syncCustomDropdown('diagnosticLogSelect');
      $('#diagnosticLog').textContent='No logs are available yet.';
      $('#diagnosticFindings').textContent='Launcher diagnostics will appear here after Eclipse records an error. Minecraft logs appear after you launch an instance.';
      $('#copyDiagnosticLog').disabled=true;
      $('#diagnosticLogStatus').textContent='No log files found.';
      return;
    }
    for(const entry of diagnosticLogEntries){
      const option=document.createElement('option');option.value=entry.id;option.textContent=entry.label;select.append(option);
      const menuOption=document.createElement('button');menuOption.type='button';menuOption.className='custom-select-option';menuOption.dataset.value=entry.id;menuOption.setAttribute('role','option');menuOption.setAttribute('aria-selected','false');menuOption.tabIndex=-1;menuOption.textContent=entry.label;menu.append(menuOption);
    }
    $('#diagnosticLogSelectTrigger').disabled=false;
    select.value=diagnosticLogEntries.some(entry=>entry.id===previous)?previous:diagnosticLogEntries[0].id;
    syncCustomDropdown('diagnosticLogSelect');
    await readSelectedDiagnosticLog();
  }catch(error){
    $('#diagnosticLogStatus').textContent=`Could not list logs: ${error.message}`;
    $('#diagnosticFindings').textContent='The diagnostic log list could not be read.';
  }finally{refresh.disabled=false;}
}

async function readSelectedDiagnosticLog(){
  const id=$('#diagnosticLogSelect').value;
  const sequence=++diagnosticReadSequence;
  if(!id){$('#diagnosticLog').textContent='No log selected.';$('#copyDiagnosticLog').disabled=true;return;}
  $('#diagnosticLog').textContent='Reading log…';
  $('#diagnosticFindings').textContent='Checking this log for common causes…';
  try{
    const log=await window.eclipse.diagnostics.read(id);
    if(sequence!==diagnosticReadSequence)return;
    $('#diagnosticLog').textContent=`${log.truncated?'[Showing the most recent 2 MB of this log.]\n\n':''}${log.text}`;
    $('#copyDiagnosticLog').disabled=!log.text;
    renderLogDiagnosis(log);
    $('#diagnosticLogStatus').textContent=`${log.label} · ${(log.size/1024).toFixed(1)} KB · Updated ${new Date(log.modified).toLocaleString()}`;
  }catch(error){
    if(sequence!==diagnosticReadSequence)return;
    $('#diagnosticLog').textContent=`Could not read this log: ${error.message}`;
    $('#diagnosticFindings').textContent='Refresh the available logs and select it again.';
    $('#copyDiagnosticLog').disabled=true;
  }
}

async function moveSidebarPage(page,offset){
  const next=[...sidebarOrder];
  const from=next.indexOf(page);
  const to=from+offset;
  if(from<0||to<0||to>=next.length)return;
  [next[from],next[to]]=[next[to],next[from]];
  try{
    await window.eclipse.settings.set({sidebarOrder:next});
    applySidebarOrder(next);
  }catch(error){alert(`Could not save the sidebar order:\n${error.message}`);}
}

function startNewsRefresh(){
  clearInterval(newsRefreshTimer);
  newsRefreshTimer=window.setInterval(()=>{
    if(newsEnabled&&document.visibilityState==='visible')loadNews(true);
  },15*60*1000);
}

function syncCustomDropdown(selectId){
  const select=$('#'+selectId);
  const root=select?.closest('.custom-select');
  if(!root)return;
  const option=[...select.options].find(item=>item.value===select.value)||select.options[0];
  const value=root.querySelector('.custom-select-value');
  if(selectId==='modInstance'){
    const instance=instances.find(item=>item.folder===select.value);
    const icon=instance?loaderLogoAsset(instance.loader):'';
    value.innerHTML=`${icon?`<img class="mod-instance-loader-icon" src="../assets/${icon}" alt="">`:''}<span>${escapeHtml(option?.textContent||'')}</span>`;
  }else value.textContent=option?.textContent||'';
  root.querySelectorAll('.custom-select-option').forEach(button=>{
    const selected=button.dataset.value===select.value;
    button.classList.toggle('selected',selected);
    button.setAttribute('aria-selected',String(selected));
  });
}

function setupCustomDropdowns(){
  const roots=[...$$('.custom-select')];
  const close=root=>{
    root.classList.remove('open');
    root.querySelector('.custom-select-trigger').setAttribute('aria-expanded','false');
  };
  const open=(root,focusOption=false)=>{
    roots.forEach(other=>{if(other!==root)close(other);});
    root.classList.add('open');
    root.querySelector('.custom-select-trigger').setAttribute('aria-expanded','true');
    if(focusOption){
      const selected=root.querySelector('.custom-select-option.selected')||root.querySelector('.custom-select-option');
      selected?.focus();
    }
  };
  roots.forEach(root=>{
    if(root.dataset.wired==='true')return;
    root.dataset.wired='true';
    const select=root.querySelector('select');
    const trigger=root.querySelector('.custom-select-trigger');
    syncCustomDropdown(select.id);
    trigger.onclick=()=>root.classList.contains('open')?close(root):open(root);
    trigger.onkeydown=event=>{
      if(['ArrowDown','ArrowUp','Enter',' '].includes(event.key)){
        event.preventDefault();
        open(root,true);
      }
    };
    const menu=root.querySelector('.custom-select-menu');
    if(menu.classList.contains('version-select-menu')){
      // Electron can send wheel events through an open dropdown to the page beneath the modal.
      // Scroll this list directly and consume the event even at either end of the list.
      menu.addEventListener('wheel',event=>{
        event.preventDefault();
        event.stopPropagation();
        menu.scrollTop+=event.deltaY;
      },{passive:false});
    }
    menu.onclick=event=>{
      const option=event.target.closest('.custom-select-option');
      if(!option)return;
      select.value=option.dataset.value;
      syncCustomDropdown(select.id);
      close(root);
      select.dispatchEvent(new Event('change',{bubbles:true}));
      trigger.focus();
    };
    menu.onkeydown=event=>{
      const options=[...root.querySelectorAll('.custom-select-option')];
      if(!options.length)return;
      const current=options.indexOf(event.target.closest('.custom-select-option'));
      let next=current;
      if(event.key==='Escape'){
        event.preventDefault();close(root);trigger.focus();return;
      }
      if(event.key==='ArrowDown')next=(current+1)%options.length;
      else if(event.key==='ArrowUp')next=(current-1+options.length)%options.length;
      else if(event.key==='Home')next=0;
      else if(event.key==='End')next=options.length-1;
      else return;
      event.preventDefault();options[next].focus();
    };
  });
  document.addEventListener('click',event=>roots.forEach(root=>{
    if(!root.contains(event.target))close(root);
  }));
  document.addEventListener('keydown',event=>{
    if(event.key==='Escape')roots.forEach(close);
  });
}

function setupAppTooltips(){
  const tooltip=document.createElement('div');
  tooltip.className='app-tooltip';
  tooltip.id='appTooltip';
  tooltip.setAttribute('role','tooltip');
  tooltip.hidden=true;
  document.body.appendChild(tooltip);
  let active=null;
  const prepare=element=>{
    if(!element||element.nodeType!==1)return;
    if(element.hasAttribute('title')){
      if(!element.hasAttribute('data-tooltip'))element.dataset.tooltip=element.getAttribute('title')||'';
      element.removeAttribute('title');
    }
    element.querySelectorAll?.('[title]').forEach(child=>{
      if(!child.hasAttribute('data-tooltip'))child.dataset.tooltip=child.getAttribute('title')||'';
      child.removeAttribute('title');
    });
  };
  const hide=()=>{active=null;tooltip.hidden=true;};
  const show=element=>{
    prepare(element);
    const message=element?.dataset.tooltip;
    if(!message)return hide();
    active=element;
    tooltip.textContent=message;
    tooltip.hidden=false;
    tooltip.classList.remove('visible');
    const rect=element.getBoundingClientRect();
    const tip=tooltip.getBoundingClientRect();
    const left=Math.max(8,Math.min(innerWidth-tip.width-8,rect.left+rect.width/2-tip.width/2));
    const top=rect.top-tip.height-9>=8?rect.top-tip.height-9:Math.min(innerHeight-tip.height-8,rect.bottom+9);
    tooltip.style.left=`${left}px`;
    tooltip.style.top=`${top}px`;
    requestAnimationFrame(()=>tooltip.classList.add('visible'));
  };
  const observer=new MutationObserver(records=>records.forEach(record=>{
    if(record.type==='attributes')prepare(record.target);
    else record.addedNodes.forEach(prepare);
  }));
  observer.observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:['title']});
  prepare(document.body);
  document.addEventListener('pointerover',event=>{
    const target=event.target.closest?.('[data-tooltip],[title]');
    if(target)show(target);
  });
  document.addEventListener('pointerout',event=>{
    if(active&&event.target.closest?.('[data-tooltip]')===active&&!active.contains(event.relatedTarget))hide();
  });
  document.addEventListener('focusin',event=>{
    const target=event.target.closest?.('[data-tooltip],[title]');
    if(target)show(target);
  });
  document.addEventListener('focusout',event=>{
    if(active&&event.target===active)hide();
  });
}

function renderInstances(){
  const q=$('#search').value.toLowerCase();
  let list=instances.filter(i=>(i.name||i.folder).toLowerCase().includes(q));
  const sort=$('#sort').value;
  list.sort((a,b)=>{
    if(sort==='name') return (a.name||'').localeCompare(b.name||'');
    if(sort==='version') return (a.version||'').localeCompare(b.version||'');
    return (b.lastPlayed||0)-(a.lastPlayed||0);
  });
  if(selectedInstanceFolder&&!instances.some(instance=>instance.folder===selectedInstanceFolder)) selectedInstanceFolder=null;
  $('#instances').innerHTML=list.map(i=>`
      <article class="instance${i.folder===selectedInstanceFolder?' selected':''}" data-folder="${escapeHtml(i.folder)}" role="group" tabindex="0" aria-label="${escapeHtml(i.name||i.folder)} instance">
      ${i.image?`<img src="${escapeHtml(i.image)}" alt="">`:''}
      <div class="instance-body">
        <div class="instance-heading"><h3><span class="instance-name-label">${escapeHtml(i.name||i.folder)}</span>${instanceIconMarkup(i)}</h3>${instanceActionsMarkup(i)}</div>
        ${instanceMetaMarkup(i)}
      </div>
    </article>`).join('') || `<div class="panel">No instances found.</div>`;
  $$('.instance[data-folder]').forEach(card=>{
    card.onclick=event=>{if(!event.target.closest('.instance-actions button'))selectInstance(card.dataset.folder);};
    card.onkeydown=event=>{if(event.target===card&&(event.key==='Enter'||event.key===' ')){event.preventDefault();selectInstance(card.dataset.folder);}};
    const renameButton=card.querySelector('.instance-rename');
    if(renameButton)renameButton.onclick=event=>{
      event.stopPropagation();
      const instance=instances.find(item=>item.folder===card.dataset.folder);
      if(instance)showRenameInstanceDialog(instance);
    };
    card.querySelector('.instance-pin').onclick=event=>{
      event.stopPropagation();
      togglePinnedInstance(card.dataset.folder);
    };
    const deleteButton=card.querySelector('.instance-delete');
    if(deleteButton)deleteButton.onclick=event=>{
      event.stopPropagation();
      const instance=instances.find(item=>item.folder===card.dataset.folder);
      if(instance)showDeleteInstanceDialog(instance);
    };
  });
  renderSelectedInstance();
}

function instanceActionsMarkup(instance){
  const name=escapeHtml(instance.name||instance.folder);
  const pinned=pinnedInstanceFolders.includes(instance.folder);
  const deleteButton=instance.official&&instance.installed===false?'':`<button class="instance-delete" type="button" aria-label="Delete files for ${name}" title="Delete instance files"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 4h11M6 4V2.5h4V4m2.5 0-.6 9.5H4.1L3.5 4m3 2v5m3-5v5"/></svg></button>`;
  return `<span class="instance-actions"><span class="instance-action-buttons"><button class="instance-pin${pinned?' pinned':''}" type="button" aria-label="${pinned?'Unpin':'Pin'} ${name} in Quick Launch" title="${pinned?'Unpin instance':'Pin to Quick Launch'}"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 2.5h6l-.7 3 2.2 2.2v1H8.5v4.8l-.5.8-.5-.8V8.7H3.5v-1l2.2-2.2L5 2.5Z"/></svg></button><button class="instance-rename" type="button" aria-label="Rename ${name}" title="Rename instance"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m2.5 11.5-.7 3 3-.7 8.1-8.1a1.63 1.63 0 0 0-2.3-2.3l-8.1 8.1Z"/><path d="m9.8 4.3 2.3 2.3"/></svg></button>${deleteButton}</span><span class="instance-install-state ${installingInstanceFolder===instance.folder?'install-state-installing':instance.installed===false?'install-state-uninstalled':'install-state-installed'}">${installingInstanceFolder===instance.folder?'Installing':instance.installed===false?'Not installed':'Installed'}</span></span>`;
}

function instanceIconMarkup(instance){
  const icon=String(instance.icon||'');
  const allowed=['ironsword445x445.png','heartlogo266x266.png','hardcore-heart402x402.png','hacker-head187x187.png','golden-apple144x144.png'];
  const identity=String(instance.folder||'').toLowerCase();
  const selected=allowed.includes(icon)?icon:(instance.official&&identity.includes('pvp')?'ironsword445x445.png':instance.official&&identity.includes('survival')?'heartlogo266x266.png':'');
  if(!selected)return '';
  const cls=selected.startsWith('iron')?'instance-sword-icon':selected.startsWith('heartlogo')?'instance-heart-icon':'instance-custom-icon';
  return `<img class="${cls}" src="../assets/${selected}" alt="" aria-hidden="true">`;
}

function instanceMetaMarkup(instance){
  const loader=String(instance.loader||'Vanilla');
  const logo=loaderLogoAsset(loader);
  return `<div class="meta instance-meta"><span>${escapeHtml(instance.version||'Unknown')}</span><span aria-hidden="true">·</span><span>${escapeHtml(loader)}</span>${logo?`<img class="fabric-loader-icon" src="../assets/${logo}" alt="" aria-hidden="true">`:''}${instance.official?'<img class="instance-official-badge" src="../assets/official-badge451x451.png" alt="" aria-hidden="true" data-tooltip="By Eclipse">':''}</div>`;
}

function openCreateInstanceDialog(){
  eclipseCustomizationOptionSequence++;
  clearInterval(eclipseCustomizationTypingTimer);
  eclipseCustomizationTypingTimer=null;
  $('#newInstanceName').value='';
  $('#newInstanceVersion').value='';
  $('#performanceModsToggle').checked=performanceModsEnabledByDefault;
  $('#utilityModsToggle').checked=utilityModsEnabledByDefault;
  $('#addOptiFineToggle').checked=false;
  $('#useTLSkinsToggle').checked=tlSkinsEnabledByDefault;
  $('#useTLSkinsToggle').disabled=true;
  $('#tlSkinsAvailability').hidden=true;
  omittedPerformanceModIds.clear();
  omittedUtilityModIds.clear();
  currentPerformanceOptions=[];
  currentPerformanceOptionKey='';
  currentUtilityOptions=[];
  currentUtilityOptionKey='';
  currentTLSkinOption=null;
  currentTLSkinOptionKey='';
  $('#configurePerformanceModsButton').setAttribute('aria-expanded','false');
  $('#performanceModsPanel').classList.remove('open');
  $('#performanceModsPanel').setAttribute('aria-hidden','true');
  $('#configureUtilityModsButton').setAttribute('aria-expanded','false');
  $('#utilityModsPanel').classList.remove('open');
  $('#utilityModsPanel').setAttribute('aria-hidden','true');
  syncCustomDropdown('newInstanceVersion');
  $('#createInstanceError').hidden=true;
  $('#createInstanceError').textContent='';
  $('#createInstanceSave').disabled=false;
  $('#createInstanceDialog').hidden=false;
  updatePerformanceOptionVisibility();
  loadEclipseCustomizationOptions();
  loadMinecraftVersionChoices().then(()=>Promise.all([loadPerformanceOptions(),loadUtilityOptions(),loadTLSkinOptions(),loadEclipseCustomizationOptions()]));
  $('#newInstanceName').focus();
}

function selectedCreateLoader(){
  return String($('#newInstanceLoader [data-loader].active')?.dataset.loader||'vanilla').toLowerCase();
}

function typeEclipseCustomizationNotice(message,neutral=false){
  const status=$('#eclipseCustomizationNotice');
  clearInterval(eclipseCustomizationTypingTimer);
  eclipseCustomizationTypingTimer=null;
  status.classList.toggle('typing-error',!neutral);
  status.classList.toggle('customization-note',neutral);
  status.hidden=!message;
  status.textContent='';
  if(!message)return;
  let index=0;
  eclipseCustomizationTypingTimer=setInterval(()=>{
    status.textContent=message.slice(0,++index);
    if(index>=message.length){clearInterval(eclipseCustomizationTypingTimer);eclipseCustomizationTypingTimer=null;}
  },35);
}

async function loadEclipseCustomizationOptions(){
  const loader=selectedCreateLoader();
  const version=$('#newInstanceVersion').value;
  const sequence=++eclipseCustomizationOptionSequence;
  if(loader==='vanilla'){
    typeEclipseCustomizationNotice('Note: Eclipse isn’t customized for Vanilla.',true);
    return;
  }
  typeEclipseCustomizationNotice('');
  if(!version)return;
  try{
    const options=await window.eclipse.instances.eclipseCustomizationOptions(version,loader);
    if(sequence!==eclipseCustomizationOptionSequence||loader!==selectedCreateLoader()||version!==$('#newInstanceVersion').value)return;
    const fancyMenu=options.find(option=>option.slug==='fancymenu');
    const craftPresence=options.find(option=>option.slug==='craftpresence');
    if(!fancyMenu?.available&&!craftPresence?.available){
      typeEclipseCustomizationNotice('This version isn’t Eclipse Customized.');
      return;
    }
    const unavailable=[];
    const loaderName=loader[0].toUpperCase()+loader.slice(1);
    if(!fancyMenu?.available)unavailable.push(`Eclipse Menu isn’t available for ${version} ${loaderName}.`);
    if(!craftPresence?.available)unavailable.push(`Eclipse Discord Rich Presence isn’t available for ${version} ${loaderName}.`);
    typeEclipseCustomizationNotice(unavailable.join(' '));
  }catch{
    if(sequence!==eclipseCustomizationOptionSequence||loader!==selectedCreateLoader()||version!==$('#newInstanceVersion').value)return;
    typeEclipseCustomizationNotice('Could not verify Eclipse customization availability. It will be checked during installation.');
  }
}

function updatePerformanceOptionVisibility(){
  const loader=selectedCreateLoader();
  $('#performanceOptions').hidden=loader==='vanilla';
  $('#tlSkinsOptions').hidden=loader==='vanilla';
  $('#fabricPerformanceOptions').hidden=loader!=='fabric';
  $('#utilityModsOptions').hidden=loader!=='fabric';
  $('#forgeOptifineOptions').hidden=loader!=='forge';
  const enabled=loader==='fabric'&&$('#performanceModsToggle').checked;
  $('#performanceModsConfig').classList.toggle('enabled',enabled);
  $('#performanceModsConfig').setAttribute('aria-hidden',String(!enabled));
  if(!enabled){
    $('#configurePerformanceModsButton').setAttribute('aria-expanded','false');
    $('#performanceModsPanel').classList.remove('open');
    $('#performanceModsPanel').setAttribute('aria-hidden','true');
  }
  const utilityEnabled=loader==='fabric'&&$('#utilityModsToggle').checked;
  $('#utilityModsConfig').classList.toggle('enabled',utilityEnabled);
  $('#utilityModsConfig').setAttribute('aria-hidden',String(!utilityEnabled));
  if(!utilityEnabled){
    $('#configureUtilityModsButton').setAttribute('aria-expanded','false');
    $('#utilityModsPanel').classList.remove('open');
    $('#utilityModsPanel').setAttribute('aria-hidden','true');
  }
}

function renderConfiguredModOptions(options,list,omitted,removeAttribute,emptyMessage){
  const visible=options.filter(option=>!option.available||!omitted.has(option.id));
  list.innerHTML=visible.map(option=>{
    const name=escapeHtml(option.name);
    if(!option.available){
      return `<div class="performance-mod-row unavailable"><span class="performance-mod-name">${name}</span><span class="performance-mod-state">Unavailable</span><span class="performance-mod-info" role="img" aria-label="Not available" title="${escapeHtml(option.reason)}">i</span></div>`;
    }
    return `<div class="performance-mod-row"><span class="performance-mod-name">${name}</span><span class="performance-mod-state">Modrinth</span><button class="performance-mod-remove" type="button" ${removeAttribute}="${escapeHtml(option.id)}" aria-label="Skip ${name} for this instance" title="Skip for this instance"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 4.5h10M6 4.5V3h4v1.5m2 0-.5 8H4.5l-.5-8m2.5 2v4m3-4v4"/></svg></button></div>`;
  }).join('')||`<span class="performance-mod-message">${emptyMessage}</span>`;
}

function renderPerformanceModOptions(options){
  currentPerformanceOptions=options;
  renderConfiguredModOptions(options,$('#performanceModsList'),omittedPerformanceModIds,'data-remove-performance-mod','No performance mods are available for this selection.');
}

function renderUtilityModOptions(options){
  currentUtilityOptions=options;
  renderConfiguredModOptions(options,$('#utilityModsList'),omittedUtilityModIds,'data-remove-utility-mod','No utility mods are available for this selection.');
}

async function loadPerformanceOptions(){
  const loader=selectedCreateLoader();
  const version=$('#newInstanceVersion').value;
  const sequence=++performanceOptionLoadSequence;
  const fabricToggle=$('#performanceModsToggle');
  const optiFineToggle=$('#addOptiFineToggle');
  updatePerformanceOptionVisibility();
  if(loader==='vanilla'){
    $('#createInstanceSave').disabled=false;
    currentPerformanceOptions=[];
    currentPerformanceOptionKey='';
    return;
  }
  if(!version){
    currentPerformanceOptions=[];
    currentPerformanceOptionKey='';
    $('#createInstanceSave').disabled=false;
    if(loader==='fabric')$('#performanceModsList').innerHTML='<span class="performance-mod-message">Choose a Minecraft version to check availability.</span>';
    if(loader==='forge'){
      optiFineToggle.checked=false;
      optiFineToggle.disabled=true;
      $('#optifineAvailability').textContent='Choose a Minecraft version to check OptiFine support.';
      $('#optifineAvailability').hidden=false;
    }
    return;
  }
  const cacheKey=`${loader}:${version}`;
  let options=performanceOptionCache[cacheKey];
  if(!options){
    $('#createInstanceSave').disabled=true;
    if(loader==='fabric')$('#performanceModsList').innerHTML='<span class="performance-mod-message">Checking Modrinth compatibility…</span>';
    else{
      optiFineToggle.disabled=true;
      $('#optifineAvailability').textContent='Checking official OptiFine compatibility…';
      $('#optifineAvailability').hidden=false;
    }
    try{options=performanceOptionCache[cacheKey]=await window.eclipse.instances.performanceOptions(version,loader);}
    catch(error){
      if(sequence!==performanceOptionLoadSequence||loader!==selectedCreateLoader()||version!==$('#newInstanceVersion').value)return;
      if(loader==='fabric')$('#performanceModsList').innerHTML=`<span class="performance-mod-message">Could not check Modrinth: ${escapeHtml(error.message||'try again.')}</span>`;
      else{
        optiFineToggle.checked=false;
        optiFineToggle.disabled=true;
        $('#optifineAvailability').textContent='Could not check OptiFine support. Check your connection and choose the version again.';
        $('#optifineAvailability').hidden=false;
      }
      $('#createInstanceSave').disabled=false;
      return;
    }
  }
  if(sequence!==performanceOptionLoadSequence||loader!==selectedCreateLoader()||version!==$('#newInstanceVersion').value)return;
  currentPerformanceOptionKey=cacheKey;
  if(loader==='fabric')renderPerformanceModOptions(options);
  else{
    const optiFine=options[0];
    optiFineToggle.disabled=!optiFine?.available;
    if(!optiFine?.available)optiFineToggle.checked=false;
    $('#optifineAvailability').textContent=optiFine?.available?(optiFine.reason||'Downloaded directly from the official OptiFine site.'):optiFine?.reason||'OptiFine is not available for this version.';
    $('#optifineAvailability').hidden=Boolean(optiFine?.available&&!optiFine.reason);
  }
  fabricToggle.disabled=false;
  $('#createInstanceSave').disabled=false;
}

async function loadUtilityOptions(){
  const loader=selectedCreateLoader();
  const version=$('#newInstanceVersion').value;
  const sequence=++utilityOptionLoadSequence;
  currentUtilityOptions=[];
  currentUtilityOptionKey='';
  if(loader!=='fabric')return;
  if(!version){
    $('#utilityModsList').innerHTML='<span class="performance-mod-message">Choose a Minecraft version to check availability.</span>';
    return;
  }
  const cacheKey=`${loader}:${version}`;
  let options=utilityOptionCache[cacheKey];
  if(!options){
    $('#utilityModsList').innerHTML='<span class="performance-mod-message">Checking Modrinth compatibility…</span>';
    try{options=utilityOptionCache[cacheKey]=await window.eclipse.instances.utilityOptions(version,loader);}
    catch(error){
      if(sequence!==utilityOptionLoadSequence||loader!==selectedCreateLoader()||version!==$('#newInstanceVersion').value)return;
      $('#utilityModsList').innerHTML=`<span class="performance-mod-message">Could not check Modrinth: ${escapeHtml(error.message||'try again.')}</span>`;
      return;
    }
  }
  if(sequence!==utilityOptionLoadSequence||loader!==selectedCreateLoader()||version!==$('#newInstanceVersion').value)return;
  currentUtilityOptionKey=cacheKey;
  renderUtilityModOptions(options);
}

async function loadTLSkinOptions(){
  const loader=selectedCreateLoader();
  const version=$('#newInstanceVersion').value;
  const toggle=$('#useTLSkinsToggle');
  const status=$('#tlSkinsAvailability');
  const sequence=++tlSkinOptionLoadSequence;
  clearInterval(tlSkinTypingTimer);
  tlSkinTypingTimer=null;
  status.classList.remove('typing-error');
  currentTLSkinOption=null;
  currentTLSkinOptionKey='';
  if(loader==='vanilla'){
    toggle.checked=false;
    toggle.disabled=true;
    status.hidden=true;
    return;
  }
  if(!version){
    toggle.disabled=true;
    status.textContent='';
    status.hidden=true;
    return;
  }
  const cacheKey=`${loader}:${version}`;
  const wasChecked=toggle.checked;
  let option=tlSkinOptionCache[cacheKey];
  if(!option){
    toggle.disabled=true;
    status.textContent='Checking TL Skin & Cape compatibility…';
    status.hidden=false;
    try{option=tlSkinOptionCache[cacheKey]=await window.eclipse.instances.tlSkinOptions(version,loader);}
    catch(error){
      if(sequence!==tlSkinOptionLoadSequence||loader!==selectedCreateLoader()||version!==$('#newInstanceVersion').value)return;
      toggle.checked=false;
      toggle.disabled=true;
      status.textContent=`Could not check TL Skin & Cape support: ${error.message||'check your connection and try again.'}`;
      status.hidden=false;
      return;
    }
  }
  if(sequence!==tlSkinOptionLoadSequence||loader!==selectedCreateLoader()||version!==$('#newInstanceVersion').value)return;
  currentTLSkinOption=option;
  currentTLSkinOptionKey=cacheKey;
  toggle.disabled=!option?.available;
  toggle.checked=Boolean(wasChecked&&option?.available);
  status.hidden=Boolean(option?.available);
  if(option?.available){
    status.textContent='Compatible file will be installed during instance setup.';
    return;
  }
  const message=`TL Skin & Cape isn't supported for Minecraft ${version}.`;
  status.classList.add('typing-error');
  status.textContent='';
  let index=0;
  tlSkinTypingTimer=setInterval(()=>{
    status.textContent=message.slice(0,++index);
    if(index>=message.length){clearInterval(tlSkinTypingTimer);tlSkinTypingTimer=null;}
  },35);
}

async function loadMinecraftVersionChoices(){
  const select=$('#newInstanceVersion');
  const menu=$('#newInstanceVersionMenu');
  const loader=String($('#newInstanceLoader [data-loader].active')?.dataset.loader||'vanilla').toLowerCase();
  const sequence=++minecraftVersionLoadSequence;
  let versions=minecraftVersionChoicesByLoader[loader];
  if(!versions){
    menu.innerHTML='<div class="version-options-loading">Loading Minecraft versions…</div>';
    $('#createInstanceSave').disabled=true;
    try{versions=minecraftVersionChoicesByLoader[loader]=await window.eclipse.instances.versions(loader);}
    catch(error){
      if(sequence===minecraftVersionLoadSequence&&loader===String($('#newInstanceLoader [data-loader].active')?.dataset.loader||'vanilla').toLowerCase()){
        menu.innerHTML='<div class="version-options-loading">Could not load supported versions. Check your connection and try again.</div>';
        $('#createInstanceSave').disabled=false;
      }
      return;
    }
  }
  if(sequence!==minecraftVersionLoadSequence||loader!==String($('#newInstanceLoader [data-loader].active')?.dataset.loader||'vanilla').toLowerCase())return;
  const selectedVersion=versions.includes(select.value)?select.value:'';
  select.innerHTML='<option value="">Choose a Minecraft version</option>'+versions.map(version=>`<option value="${escapeHtml(version)}">${escapeHtml(version)}</option>`).join('');
  select.value=selectedVersion;
  menu.innerHTML=versions.length?versions.map(version=>`<button class="custom-select-option${select.value===version?' selected':''}" type="button" role="option" data-value="${escapeHtml(version)}" aria-selected="${select.value===version}" tabindex="-1">${escapeHtml(version)}</button>`).join(''):'<div class="version-options-loading">No supported releases are available for this loader.</div>';
  syncCustomDropdown('newInstanceVersion');
  $('#createInstanceSave').disabled=false;
}

function showCreateInstanceError(message, typewriter=false){
  const output=$('#createInstanceError');
  clearInterval(createErrorTypingTimer);
  output.classList.toggle('typing-error',typewriter);
  output.hidden=false;
  if(!typewriter){output.textContent=message;return;}
  output.textContent='';
  let index=0;
  createErrorTypingTimer=setInterval(()=>{
    output.textContent=message.slice(0,++index);
    if(index>=message.length){clearInterval(createErrorTypingTimer);createErrorTypingTimer=null;}
  },35);
}

function closeCreateInstanceDialog(){
  clearInterval(createErrorTypingTimer);
  createErrorTypingTimer=null;
  utilityOptionLoadSequence++;
  eclipseCustomizationOptionSequence++;
  clearInterval(eclipseCustomizationTypingTimer);
  eclipseCustomizationTypingTimer=null;
  $('#createInstanceDialog').hidden=true;
  $('#createInstanceSave').disabled=false;
}

async function createInstance(){
  const button=$('#createInstanceSave');
  if(button.disabled)return;
  const error=$('#createInstanceError');
  const version=$('#newInstanceVersion').value;
  const name=$('#newInstanceName').value.trim().replace(/\s+/g,' ');
  if(!name||name.length>32){showCreateInstanceError('Enter an instance name between 1 and 32 characters long.',true);return;}
  if(!version){showCreateInstanceError('Choose a Minecraft Version',true);return;}
  const loader=$('#newInstanceLoader [data-loader].active')?.dataset.loader||'vanilla';
  if(!minecraftVersionChoicesByLoader[String(loader).toLowerCase()]?.includes(version)){
    showCreateInstanceError(`Choose a Minecraft version supported by ${loader}.`,true);
    return;
  }
  const optionKey=`${String(loader).toLowerCase()}:${version}`;
  if(loader==='fabric'&&$('#performanceModsToggle').checked&&currentPerformanceOptionKey!==optionKey){
    showCreateInstanceError('Wait for Fabric mod compatibility checks to finish, then try again.',true);
    return;
  }
  if(String(loader).toLowerCase()==='fabric'&&$('#utilityModsToggle').checked&&currentUtilityOptionKey!==optionKey){
    showCreateInstanceError('Wait for Utility Mods compatibility checks to finish, then try again.',true);
    return;
  }
  if($('#useTLSkinsToggle').checked&&(currentTLSkinOptionKey!==optionKey||!currentTLSkinOption?.available)){
    showCreateInstanceError('Wait for TL Skin & Cape compatibility checks to finish, then try again.',true);
    return;
  }
  const performanceMods=loader==='fabric'&&$('#performanceModsToggle').checked
    ?currentPerformanceOptions.filter(option=>option.available&&!omittedPerformanceModIds.has(option.id)).map(option=>option.id)
    :[];
  const utilityMods=String(loader).toLowerCase()==='fabric'&&$('#utilityModsToggle').checked
    ?currentUtilityOptions.filter(option=>option.available&&!omittedUtilityModIds.has(option.id)).map(option=>option.id)
    :[];
  const addOptiFine=loader==='forge'&&$('#addOptiFineToggle').checked;
  const useTLSkins=['fabric','forge'].includes(String(loader).toLowerCase())&&$('#useTLSkinsToggle').checked;
  const icon=$('#newInstanceIcon [data-icon].active')?.dataset.icon||'';
  button.disabled=true;
  error.hidden=true;
  try{
    const created=await window.eclipse.instances.create({name,version,loader,icon,performanceMods,utilityMods,addOptiFine,useTLSkins});
    instances=await window.eclipse.instances.list();
    closeCreateInstanceDialog();
    selectedInstanceFolder=created.folder;
    renderInstances();
    renderQuick();
    setupModsPage();
  }catch(cause){
    const message=String(cause.message||'Could not create the instance.').replace(/^Error invoking remote method '[^']+':\s*Error:\s*/,'');
    if(/instance name between 1 and 32 characters/i.test(message))showCreateInstanceError('Enter an instance name between 1 and 32 characters long.',true);
    else showCreateInstanceError(/version number|Minecraft version/i.test(message)?'Choose a Minecraft Version':message,/version number|Minecraft version/i.test(message));
  }finally{button.disabled=false;}
}

function selectInstance(folder){
  if(!instances.some(instance=>instance.folder===folder)) return;
  if(folder!==selectedInstanceFolder)selectedControlsShouldAnimate=true;
  selectedInstanceFolder=folder;
  renderInstances();
}

function renderSelectedInstance(){
  const selected=instances.find(instance=>instance.folder===selectedInstanceFolder);
  const play=$('#selectedInstancePlay');
  const playtime=$('#selectedInstancePlaytime');
  if(!selected){
    play.hidden=true;
    play.classList.remove('play-appear');
    playtime.hidden=true;
    playtime.classList.remove('play-appear');
    selectedControlsShouldAnimate=false;
    return;
  }
  const animate=selectedControlsShouldAnimate||play.hidden;
  const animatePlaytime=showPlaytime&&(selectedControlsShouldAnimate||playtime.hidden);
  playtime.hidden=!showPlaytime;
  $('#selectedInstancePlaytimeValue').textContent=formatInstancePlaytime(selected.playtimeMs);
  play.hidden=false;
  const installing=installingInstanceFolder===selected.folder;
  const starting=launchingInstanceFolder===selected.folder;
  const playing=playingInstanceFolder===selected.folder;
  const anotherGameActive=Boolean((launchingInstanceFolder||playingInstanceFolder)&&!starting&&!playing);
  const busy=installing||starting||playing||anotherGameActive;
  play.disabled=busy;
  play.classList.toggle('installing',installing||starting);
  play.classList.toggle('is-busy',busy);
  if(installing){
    play.innerHTML='<span class="button-spinner" aria-hidden="true"></span> INSTALLING…';
  }else if(starting){
    play.innerHTML='<span class="button-spinner" aria-hidden="true"></span> LOADING…';
  }else if(playing){
    play.textContent='PLAYING';
  }else if(anotherGameActive&&selected.installed){
    play.textContent='GAME RUNNING';
  }else if(selected.installed===false){
    play.innerHTML='<svg class="install-button-icon" viewBox="0 0 20 20" aria-hidden="true"><path d="M10 2.5v9m0 0 3.5-3.5M10 11.5 6.5 8M3 13.5v3h14v-3"/></svg> INSTALL';
  }else{
    play.innerHTML='<svg class="install-button-icon play-button-icon" viewBox="0 0 20 20" aria-hidden="true"><path d="m6 3.5 10 6.5-10 6.5z"/></svg> PLAY';
  }
  play.setAttribute('aria-label',`${installing?'Installing':starting?'Loading':playing?'Playing':anotherGameActive&&selected.installed?'Another Minecraft instance is running':selected.installed===false?'Install':'Play'} ${selected.name||selected.folder}`);
  if(animate){
    play.classList.remove('play-appear');
    void play.offsetWidth;
    play.classList.add('play-appear');
  }
  if(animatePlaytime){
    playtime.classList.remove('play-appear');
    void playtime.offsetWidth;
    playtime.classList.add('play-appear');
  }
  selectedControlsShouldAnimate=false;
}

function formatInstancePlaytime(milliseconds){
  const minutes=Math.floor(Math.max(0,Number(milliseconds)||0)/60000);
  const hours=Math.floor(minutes/60);
  return `${String(hours).padStart(2,'0')}h${String(minutes%60).padStart(2,'0')}`;
}

function renderPlaytimeSettings(){
  const total=instances.reduce((sum,instance)=>sum+Math.max(0,Number(instance.playtimeMs)||0),0);
  $('#playtimeTotal').textContent=formatInstancePlaytime(total);
  const sorted=[...instances].sort((a,b)=>(Number(b.playtimeMs)||0)-(Number(a.playtimeMs)||0));
  $('#playtimeStats').innerHTML=sorted.length?sorted.map(instance=>{
    const time=Math.max(0,Number(instance.playtimeMs)||0);
    const percent=total?time/total*100:0;
    const busy=installingInstanceFolder===instance.folder||launchingInstanceFolder===instance.folder||playingInstanceFolder===instance.folder;
    return `<div class="playtime-stat-row">
      <div class="playtime-stat-heading"><div><strong>${escapeHtml(instance.name||instance.folder)}</strong><span>${formatInstancePlaytime(time)} <i>·</i> ${percent.toFixed(1)}%</span></div><button type="button" class="playtime-reset" data-reset-playtime="${escapeHtml(instance.folder)}" ${busy?'disabled':''}>Reset</button></div>
      <div class="playtime-meter" role="progressbar" aria-label="${escapeHtml(instance.name||instance.folder)} share of total playtime" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent.toFixed(1)}"><span style="width:${percent.toFixed(2)}%"></span></div>
    </div>`;
  }).join(''):'<div class="playtime-empty">No instances found.</div>';
  $$('[data-reset-playtime]').forEach(button=>button.onclick=()=>showResetPlaytimeDialog(button.dataset.resetPlaytime));
}

function showResetPlaytimeDialog(folder){
  const instance=instances.find(item=>item.folder===folder);
  if(!instance)return;
  resetPlaytimeTarget=instance;
  $('#resetPlaytimeTitle').textContent=`Reset ${instance.name||instance.folder} playtime?`;
  $('#resetPlaytimeDescription').textContent=`This will reset this instance's tracked playtime of ${formatInstancePlaytime(instance.playtimeMs)} to 00h00. This cannot be undone.`;
  $('#resetPlaytimeError').hidden=true;
  $('#resetPlaytimeError').textContent='';
  $('#resetPlaytimeDialog').hidden=false;
  $('#resetPlaytimeCancel').focus();
}

function closeResetPlaytimeDialog(){
  if(resettingPlaytime)return;
  $('#resetPlaytimeDialog').hidden=true;
  resetPlaytimeTarget=null;
}

async function confirmResetPlaytime(){
  if(!resetPlaytimeTarget)return;
  const target=resetPlaytimeTarget;
  const cancel=$('#resetPlaytimeCancel');
  const confirm=$('#resetPlaytimeConfirm');
  cancel.disabled=true;
  confirm.disabled=true;
  resettingPlaytime=true;
  try{
    await window.eclipse.instances.resetPlaytime(target.folder);
    target.playtimeMs=0;
    resettingPlaytime=false;
    closeResetPlaytimeDialog();
    renderPlaytimeSettings();
    renderSelectedInstance();
    showInstanceNotice(`${target.name||target.folder} playtime was reset.`);
  }catch(error){
    $('#resetPlaytimeError').textContent=error.message;
    $('#resetPlaytimeError').hidden=false;
  }finally{
    resettingPlaytime=false;
    cancel.disabled=false;
    confirm.disabled=false;
  }
}

function showInstanceNotice(message){
  const notice=$('#appNotice');
  notice.textContent=message;
  notice.hidden=false;
  clearTimeout(notice._hideTimer);
  notice._hideTimer=setTimeout(()=>{notice.hidden=true;},3600);
}

function updateInstanceInstallProgress(progress){
  const panel=$('#instanceInstallProgress');
  const percent=progress.percent;
  const isLaunch=progress.kind==='launch';
  clearTimeout(installProgressTimer);
  if(progress.phase==='complete'){
    panel.classList.remove('error','indeterminate');
    $('#instanceInstallProgressTitle').textContent=progress.status==='Minecraft started'?'Minecraft started':'Instance ready';
    $('#instanceInstallProgressStatus').textContent=progress.status;
    $('#instanceInstallProgressFill').style.width='100%';
    installProgressTimer=setTimeout(()=>{panel.hidden=true;},1800);
    return;
  }
  panel.hidden=false;
  panel.classList.toggle('launch-progress',isLaunch);
  panel.classList.toggle('error',progress.phase==='error');
  panel.classList.toggle('indeterminate',!isLaunch&&percent==null);
  $('#instanceInstallProgressTitle').textContent=isLaunch?'Preparing Minecraft':progress.phase==='minecraft-startup'?'Loading Minecraft':progress.phase==='dependencies'||progress.phase==='launching'?'Preparing Minecraft':`Installing ${instances.find(item=>item.folder===progress.folder)?.name||'instance'}`;
  $('#instanceInstallProgressStatus').hidden=isLaunch;
  $('#instanceInstallProgressStatus').textContent=isLaunch?'':progress.status||'Working…';
  $('#instanceInstallProgressFill').style.width=percent==null?'35%':`${Math.max(0,Math.min(100,percent))}%`;
  if(progress.phase==='error'){
    installProgressTimer=setTimeout(()=>{panel.hidden=true;},7000);
  }
}

async function installInstance(folder){
  const instance=instances.find(item=>item.folder===folder);
  if(!instance||instance.installed||installingInstanceFolder)return;
  installingInstanceFolder=folder;
  renderInstances();
  $('#instanceInstallProgress').hidden=false;
  $('#instanceInstallProgressTitle').textContent=`Installing ${instance.name||instance.folder}`;
  $('#instanceInstallProgressStatus').hidden=false;
  $('#instanceInstallProgress').classList.remove('launch-progress');
  $('#instanceInstallProgressStatus').textContent='Starting download…';
  $('#instanceInstallProgressFill').style.width='0%';
  $('#instanceInstallProgress').classList.add('indeterminate');
  try{
    await window.eclipse.instances.install(folder);
    instances=await window.eclipse.instances.list();
    renderInstances();
    renderQuick();
    showInstanceNotice(`${instance.name||instance.folder} is installed and ready to play.`);
  }catch(error){
    showInstanceNotice(`Could not install ${instance.name||instance.folder}: ${error.message}`);
  }finally{
    installingInstanceFolder=null;
    renderInstances();
    renderQuick();
  }
}

async function launch(folder){
  const instance=instances.find(x=>x.folder===folder);
  if(!instance) return;
  if(instance.installed===false){
    showInstanceNotice('Install this instance before launching it.');
    return;
  }
  if(launchingInstanceFolder||playingInstanceFolder){
    showInstanceNotice('Minecraft is already starting or running. Close it before launching another instance.');
    return;
  }
  launchingInstanceFolder=folder;
  $('#instanceInstallProgress').hidden=false;
  $('#instanceInstallProgress').classList.remove('error');
  $('#instanceInstallProgress').classList.remove('indeterminate');
  $('#instanceInstallProgress').classList.add('launch-progress');
  $('#instanceInstallProgressTitle').textContent='Preparing Minecraft';
  $('#instanceInstallProgressStatus').hidden=true;
  $('#instanceInstallProgressFill').style.width='5%';
  renderInstances();
  renderQuick();
  try{
    await window.eclipse.instances.launch(instance);
    renderInstances(); renderQuick();
  }catch(e){
    window.eclipse.diagnostics.reportRendererError({kind:'Minecraft launch failure',message:`${instance.name||instance.folder}: ${e.message||e}`,detail:e.stack||''});
    launchingInstanceFolder=null;
    $('#instanceInstallProgress').hidden=false;
    $('#instanceInstallProgress').classList.add('error');
    $('#instanceInstallProgressStatus').hidden=false;
    $('#instanceInstallProgressTitle').textContent='Minecraft could not start';
    $('#instanceInstallProgressStatus').textContent=e.message;
    clearTimeout(installProgressTimer);
    installProgressTimer=setTimeout(()=>{$('#instanceInstallProgress').hidden=true;},8000);
    renderInstances();
    renderQuick();
    showInstanceNotice(`Could not launch Minecraft: ${e.message}`);
  }
}

function updateLaunchStatus(status){
  const instance=instances.find(item=>item.folder===status.folder);
  if(instance){
    if(Number.isFinite(status.playtimeMs))instance.playtimeMs=status.playtimeMs;
    if(Number.isFinite(status.lastPlayed))instance.lastPlayed=status.lastPlayed;
  }
  if(status.state==='preparing'||status.state==='loading'){
    launchingInstanceFolder=status.folder;
    renderInstances();
    renderQuick();
    renderPlaytimeSettings();
    return;
  }
  if(status.state==='playing'){
    launchingInstanceFolder=null;
    playingInstanceFolder=status.folder;
    $('#instanceInstallProgress').hidden=true;
    renderInstances();
    renderQuick();
    renderPlaytimeSettings();
    return;
  }
  if(status.state==='failed'||status.state==='closed'){
    const wasPlaying=playingInstanceFolder===status.folder;
    const wasLoading=launchingInstanceFolder===status.folder;
    launchingInstanceFolder=null;
    playingInstanceFolder=null;
    $('#instanceInstallProgress').hidden=true;
    renderInstances();
    renderQuick();
    renderPlaytimeSettings();
    if(status.state==='failed')showInstanceNotice(`Minecraft could not start: ${status.message||'Unknown launch error.'}`);
    else if((wasPlaying||wasLoading)&&status.code!=null&&status.code!==0)showInstanceNotice(`Minecraft closed with exit code ${status.code}. Check the instance's latest.log for details.`);
  }
}

function renderQuick(){
  const pinned=pinnedInstanceFolders.map(folder=>instances.find(instance=>instance.folder===folder&&instance.installed)).filter(Boolean);
  $('#quickLaunch').innerHTML=pinned.length?pinned.map(instance=>{
    const active=playingInstanceFolder===instance.folder;
    const busy=Boolean(launchingInstanceFolder||playingInstanceFolder);
    return `<article class="quick-pin-item"><b class="quick-instance-name"><span>${escapeHtml(instance.name||instance.folder)}</span>${instanceIconMarkup(instance)}</b>${instanceMetaMarkup(instance)}<button class="play${active||busy?' is-busy':''}" data-folder="${escapeHtml(instance.folder)}" ${busy?'disabled':''}>${active?'PLAYING':launchingInstanceFolder===instance.folder?'LOADING…':'▶ PLAY'}</button></article>`;
  }).join(''):'<div class="quick-empty">No pinned instance</div>';
  $$('#quickLaunch .play').forEach(button=>button.onclick=()=>launch(button.dataset.folder));
}

async function togglePinnedInstance(folder){
  const instance=instances.find(item=>item.folder===folder);
  if(!instance?.installed){
    showInstanceNotice('Install this instance before pinning it to Quick Launch.');
    return;
  }
  const next=pinnedInstanceFolders.includes(folder)
    ?pinnedInstanceFolders.filter(item=>item!==folder)
    :[...pinnedInstanceFolders,folder];
  try{
    await window.eclipse.settings.set({pinnedInstances:next});
    pinnedInstanceFolders=next;
    renderInstances();
    renderQuick();
  }catch(error){alert(`Could not update pinned instances:\n${error.message}`);}
}

async function loadNews(refresh=false){
  const container=$('#newsList');
  try{
    newsItems=await window.eclipse.news.list({refresh});
    if(!newsItems.length) throw new Error('No articles');
    container.innerHTML=newsItems.slice(0,6).map((n,index)=>`
      <article class="news-item" data-news="${index}">
        <div class="news-image-wrap">${n.image?`<img src="${escapeHtml(n.image)}" alt="" onerror="this.parentElement.classList.add('no-image');this.remove()">`:`<div class="news-image-fallback">⛏</div>`}</div>
        <div class="news-copy">
          <span class="tag">${escapeHtml(n.source==='Minecraft.net'?'Minecraft.net':'Minecraft News · cached official feed')}</span>
          <h3>${escapeHtml(n.title)}</h3>
          <p>${escapeHtml(n.description||'Official Minecraft news from Minecraft.net.')}</p>
          <small>${escapeHtml(formatDate(n.pubDate))}</small>
        </div>
        <button class="news-open" data-news="${index}">Read More →</button>
      </article>`).join('');
    $$('.news-open').forEach(b=>b.onclick=()=>openNews(Number(b.dataset.news)));
  }catch(e){
    container.innerHTML=`<article class="news-item news-error"><div><span class="tag">Minecraft</span><h3>Could not load Minecraft News</h3><p>Minecraft news is temporarily unavailable. Please try again later.</p></div><button id="retryNews">Retry</button></article>`;
    $('#retryNews').onclick=()=>loadNews(true);
  }
}

function formatDate(value){
  if(!value) return '';
  const d=new Date(value);
  return Number.isNaN(d.getTime())?value:d.toLocaleDateString(undefined,{year:'numeric',month:'short',day:'numeric'});
}

async function openNews(index){
  const item=newsItems[index];
  if(!item?.link) return;
  try{ await window.eclipse.news.open(item.link); }
  catch(e){ alert('Could not open this Minecraft article:\n'+e.message); }
}

function escapeHtml(x){return String(x).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));}

$$('.nav').forEach(b=>b.onclick=()=>{
  const nextPage=$('#'+b.dataset.page);
  if(!nextPage||nextPage.classList.contains('active-page'))return;
  $$('.nav').forEach(x=>x.classList.remove('active')); b.classList.add('active');
  $$('.page').forEach(page=>page.classList.remove('active-page','page-enter'));
  nextPage.classList.add('active-page');
  if(skinViewer){
    skinViewer.viewer.renderPaused=b.dataset.page!=='profile';
    if(b.dataset.page==='profile')requestAnimationFrame(skinViewer.resize);
  }
  if(b.dataset.page==='mods')refreshCurrentInstalledContent();
  if(b.dataset.page==='settings')refreshDiagnosticLogs();
  clearTimeout(pageAnimationTimer);
  if(pageAnimationDuration>0){
    void nextPage.offsetWidth;
    nextPage.classList.add('page-enter');
    pageAnimationTimer=setTimeout(()=>nextPage.classList.remove('page-enter'),pageAnimationDuration+50);
  }
});

$('#diagnosticLogSelect').onchange=readSelectedDiagnosticLog;
$('#refreshDiagnosticLogs').onclick=()=>refreshDiagnosticLogs(true);
$('#copyDiagnosticLog').onclick=async()=>{
  try{
    await navigator.clipboard.writeText($('#diagnosticLog').textContent||'');
    $('#diagnosticLogStatus').textContent='Log copied to the clipboard.';
  }catch(error){$('#diagnosticLogStatus').textContent=`Could not copy the log: ${error.message}`;}
};

$('#search').oninput=renderInstances;
$('#sort').onchange=renderInstances;
$('#selectedInstancePlay').onclick=()=>{
  const instance=instances.find(item=>item.folder===selectedInstanceFolder);
  if(!instance)return;
  if(instance.installed===false)installInstance(instance.folder);
  else launch(instance.folder);
};
$('#changeBg').onclick=async()=>{
  const selected=await window.eclipse.background.choose();
  if(selected?.url) setBackgroundImage(selected.url);
};
$('#theme').onchange=async e=>{
  document.body.classList.toggle('light',e.target.value==='light');
  if(currentBackgroundImageUrl)setBackgroundImage(currentBackgroundImageUrl);
  await window.eclipse.settings.set({theme:e.target.value});
};
$('#animationSpeed').onchange=async e=>{
  const speed=e.target.value;
  setAnimationSpeed(speed);
  await window.eclipse.settings.set({animationSpeed:speed});
};
$('#playAnimationSpeed').onchange=async e=>{
  const speed=e.target.value;
  setPlayAnimationSpeed(speed);
  await window.eclipse.settings.set({playAnimationSpeed:speed});
};
$('#showPlaytimeToggle').onchange=async e=>{
  try{
    const settings=await window.eclipse.settings.set({showPlaytime:e.target.checked});
    showPlaytime=settings.showPlaytime!==false;
    e.target.checked=showPlaytime;
    renderSelectedInstance();
  }catch(error){
    e.target.checked=showPlaytime;
    showInstanceNotice(`Could not save the playtime display setting: ${error.message}`);
  }
};
$('#playtimePosition').onchange=async e=>{
  const previous=playtimePosition;
  try{
    const settings=await window.eclipse.settings.set({playtimePosition:e.target.value});
    playtimePosition=settings.playtimePosition==='right'?'right':'left';
    e.target.value=playtimePosition;
    syncCustomDropdown('playtimePosition');
    $('.selected-instance-bar').classList.toggle('playtime-right',playtimePosition==='right');
  }catch(error){
    e.target.value=previous;
    syncCustomDropdown('playtimePosition');
    showInstanceNotice(`Could not save the playtime position: ${error.message}`);
  }
};
$('#newsEnabledToggle').onchange=async e=>{
  const enabled=e.target.checked;
  try{
    const settings=await window.eclipse.settings.set({newsEnabled:enabled});
    newsEnabled=settings.newsEnabled!==false;
    $('#newsEnabledToggle').checked=newsEnabled;
    $('#newsSection').hidden=!newsEnabled;
    if(newsEnabled){
      await loadNews();
      startNewsRefresh();
    }else{
      clearInterval(newsRefreshTimer);
      newsRefreshTimer=null;
    }
  }catch(error){
    e.target.checked=newsEnabled;
    alert(`Could not save the Minecraft News setting:\n${error.message}`);
  }
};
$('#showFriendsBoxToggle').onchange=async e=>{
  const show=e.target.checked;
  try{
    const settings=await window.eclipse.settings.set({showFriendsBox:show});
    const visible=settings.showFriendsBox!==false;
    e.target.checked=visible;
    $('#friendsBox').hidden=!visible;
  }catch(error){
    e.target.checked=!$('#friendsBox').hidden;
    showInstanceNotice(`Could not save the Friends box setting: ${error.message}`);
  }
};
$('#showQuickLaunchToggle').onchange=async e=>{
  const show=e.target.checked;
  try{
    const settings=await window.eclipse.settings.set({showQuickLaunch:show});
    const visible=settings.showQuickLaunch!==false;
    e.target.checked=visible;
    $('#quickLaunchPanel').hidden=!visible;
  }catch(error){
    e.target.checked=!$('#quickLaunchPanel').hidden;
    showInstanceNotice(`Could not save the Quick Launch setting: ${error.message}`);
  }
};
$('#accountCard').onclick=()=>$('#statusPop').classList.toggle('open');
$$('[data-status]').forEach(x=>x.onclick=async()=>{
  const status=x.dataset.status;
  const s=await window.eclipse.settings.get();
  s.profile.status=status;
  await window.eclipse.settings.set({profile:s.profile});
  updateStatusUI(status); $('#statusPop').classList.remove('open');
});
$$('[data-window]').forEach(b=>b.onclick=()=>{
  const a=b.dataset.window;
  window.eclipse.window[a==='min'?'minimize':a==='max'?'maximize':'close']();
});
$('#addProfileBtn').onclick=()=>{
  $('#profileCreator').hidden=false;
  setAccountType('offline');
  $('#offlineProfileName').focus();
};
$('#cancelAddProfile').onclick=()=>$('#profileCreator').hidden=true;
$$('[data-account-type]').forEach(button=>button.onclick=()=>setAccountType(button.dataset.accountType));
$('#createOfflineProfile').onclick=async()=>{
  const button=$('#createOfflineProfile');
  button.disabled=true;
  try{
    const updated=await window.eclipse.accounts.addOffline($('#offlineProfileName').value);
    renderProfiles(updated);
    applySettings(updated);
    $('#profileCreator').hidden=true;
    $('#offlineProfileName').value='';
  }catch(error){showAccountMessage(error.message,true);}
  finally{button.disabled=false;}
};
$('#loginMicrosoft').onclick=async()=>{
  const button=$('#loginMicrosoft');
  button.disabled=true;
  showAccountMessage('Opening Microsoft sign-in in your browser…');
  try{
    const updated=await window.eclipse.accounts.loginMicrosoft($('#microsoftClientId').value);
    renderProfiles(updated);
    applySettings(updated);
    $('#profileCreator').hidden=true;
    showAccountMessage('Microsoft account added.');
  }catch(error){showAccountMessage(error.message,true);}
  finally{button.disabled=false;}
};
$('#openEntraPortal').onclick=async event=>{
  event.preventDefault();
  await window.eclipse.accounts.openRegistration();
};
$('#removeProfileCancel').onclick=closeRemoveProfileDialog;
$('#resetPlaytimeCancel').onclick=closeResetPlaytimeDialog;
$('#resetPlaytimeConfirm').onclick=confirmResetPlaytime;
$('#createInstanceButton').onclick=openCreateInstanceDialog;
$('#createInstanceCancel').onclick=closeCreateInstanceDialog;
$('#createInstanceSave').onclick=createInstance;
$('#createInstanceDialog').onclick=event=>{if(event.target.id==='createInstanceDialog')closeCreateInstanceDialog();};
$('#newInstanceVersion').onchange=()=>{
  clearInterval(createErrorTypingTimer);
  createErrorTypingTimer=null;
  $('#createInstanceError').hidden=true;
  $('#createInstanceError').classList.remove('typing-error');
  loadPerformanceOptions();
  loadUtilityOptions();
  loadTLSkinOptions();
  loadEclipseCustomizationOptions();
};
$('#newInstanceName').oninput=()=>{
  clearInterval(createErrorTypingTimer);
  createErrorTypingTimer=null;
  $('#createInstanceError').hidden=true;
  $('#createInstanceError').classList.remove('typing-error');
};
$('#newInstanceLoader').onclick=event=>{
  const button=event.target.closest('[data-loader]');
  if(!button)return;
  if(button.classList.contains('active'))return;
  eclipseCustomizationOptionSequence++;
  typeEclipseCustomizationNotice('');
  $$('#newInstanceLoader [data-loader]').forEach(option=>option.classList.toggle('active',option===button));
  $('#addOptiFineToggle').checked=false;
  $('#useTLSkinsToggle').checked=button.dataset.loader==='vanilla'?false:tlSkinsEnabledByDefault;
  $('#useTLSkinsToggle').disabled=true;
  $('#tlSkinsAvailability').hidden=true;
  currentPerformanceOptions=[];
  currentPerformanceOptionKey='';
  currentUtilityOptions=[];
  currentUtilityOptionKey='';
  currentTLSkinOption=null;
  currentTLSkinOptionKey='';
  updatePerformanceOptionVisibility();
  clearInterval(createErrorTypingTimer);
  createErrorTypingTimer=null;
  $('#createInstanceError').hidden=true;
  $('#createInstanceError').classList.remove('typing-error');
  loadMinecraftVersionChoices().then(()=>Promise.all([loadPerformanceOptions(),loadUtilityOptions(),loadTLSkinOptions(),loadEclipseCustomizationOptions()]));
};
$('#performanceModsToggle').onchange=()=>{
  performanceModsEnabledByDefault=$('#performanceModsToggle').checked;
  window.eclipse.settings.set({performanceModsEnabledByDefault}).catch(error=>showCreateInstanceError(`Could not save this preference: ${error.message}`));
  updatePerformanceOptionVisibility();
  if($('#performanceModsToggle').checked)loadPerformanceOptions();
};
$('#utilityModsToggle').onchange=()=>{
  utilityModsEnabledByDefault=$('#utilityModsToggle').checked;
  window.eclipse.settings.set({utilityModsEnabledByDefault}).catch(error=>showCreateInstanceError(`Could not save this preference: ${error.message}`));
  updatePerformanceOptionVisibility();
  if($('#utilityModsToggle').checked)loadUtilityOptions();
};
$('#useTLSkinsToggle').onchange=()=>{
  tlSkinsEnabledByDefault=$('#useTLSkinsToggle').checked;
  window.eclipse.settings.set({useTLSkinsEnabledByDefault:tlSkinsEnabledByDefault}).catch(error=>showCreateInstanceError(`Could not save this preference: ${error.message}`));
  if($('#useTLSkinsToggle').checked&&(!currentTLSkinOption?.available||currentTLSkinOptionKey!==`${selectedCreateLoader()}:${$('#newInstanceVersion').value}`))loadTLSkinOptions();
};
$('#configurePerformanceModsButton').onclick=()=>{
  const button=$('#configurePerformanceModsButton');
  const expanded=button.getAttribute('aria-expanded')==='true';
  button.setAttribute('aria-expanded',String(!expanded));
  $('#performanceModsPanel').classList.toggle('open',!expanded);
  $('#performanceModsPanel').setAttribute('aria-hidden',String(expanded));
};
$('#configureUtilityModsButton').onclick=()=>{
  const button=$('#configureUtilityModsButton');
  const expanded=button.getAttribute('aria-expanded')==='true';
  button.setAttribute('aria-expanded',String(!expanded));
  $('#utilityModsPanel').classList.toggle('open',!expanded);
  $('#utilityModsPanel').setAttribute('aria-hidden',String(expanded));
};
$('#performanceModsList').onclick=event=>{
  const button=event.target.closest('[data-remove-performance-mod]');
  if(!button)return;
  omittedPerformanceModIds.add(button.dataset.removePerformanceMod);
  const row=button.closest('.performance-mod-row');
  if(row){
    row.style.animation='performance-row-remove .16s ease-in both';
    setTimeout(()=>row.remove(),160);
  }
};
$('#utilityModsList').onclick=event=>{
  const button=event.target.closest('[data-remove-utility-mod]');
  if(!button)return;
  omittedUtilityModIds.add(button.dataset.removeUtilityMod);
  const row=button.closest('.performance-mod-row');
  if(row){
    row.style.animation='performance-row-remove .16s ease-in both';
    setTimeout(()=>row.remove(),160);
  }
};
$('#newInstanceIcon').onclick=event=>{
  const button=event.target.closest('[data-icon]');
  if(!button)return;
  $$('#newInstanceIcon [data-icon]').forEach(option=>option.classList.toggle('active',option===button));
};
$('#resetPlaytimeDialog').onclick=event=>{
  if(event.target.id==='resetPlaytimeDialog')closeResetPlaytimeDialog();
};
$('#removeProfileDialog').onclick=event=>{
  if(event.target.id==='removeProfileDialog')closeRemoveProfileDialog();
};
$('#removeProfileConfirm').onclick=async()=>{
  if(!removeProfileTarget)return;
  const button=$('#removeProfileConfirm');
  button.disabled=true;
  try{
    const updated=await window.eclipse.accounts.remove(removeProfileTarget.id);
    closeRemoveProfileDialog();
    renderProfiles(updated);
    applySettings(updated);
  }catch(error){
    $('#removeProfileError').textContent=error.message;
    $('#removeProfileError').hidden=false;
  }finally{button.disabled=false;}
};
$('#renameInstanceCancel').onclick=closeRenameInstanceDialog;
$('#renameInstanceDialog').onclick=event=>{
  if(event.target.id==='renameInstanceDialog')closeRenameInstanceDialog();
};
$('#renameInstanceIcons').onclick=event=>{
  const button=event.target.closest('[data-icon]');
  if(!button)return;
  renameInstanceIcon=button.dataset.icon||'';
  $$('#renameInstanceIcons [data-icon]').forEach(option=>option.classList.toggle('active',option===button));
};
$('#renameInstanceSave').onclick=async()=>{
  if(!renameInstanceTarget)return;
  const button=$('#renameInstanceSave');
  const name=$('#renameInstanceInput').value.trim();
  button.disabled=true;
  try{
    const previousFolder=renameInstanceTarget.folder;
    const renamed=await window.eclipse.instances.rename(previousFolder,name,renameInstanceIcon);
    instances=await window.eclipse.instances.list();
    if(selectedInstanceFolder===previousFolder)selectedInstanceFolder=renamed.folder;
    if(savedModsInstanceFolder===previousFolder)savedModsInstanceFolder=renamed.folder;
    pinnedInstanceFolders=pinnedInstanceFolders.map(folder=>folder===previousFolder?renamed.folder:folder);
    closeRenameInstanceDialog();
    setupModsPage();
    await window.eclipse.settings.set({modsInstanceFolder:savedModsInstanceFolder,pinnedInstances:pinnedInstanceFolders}).catch(()=>{});
    renderInstances();
    renderQuick();
    renderPlaytimeSettings();
  }catch(error){
    $('#renameInstanceError').textContent=error.message;
    $('#renameInstanceError').hidden=false;
    $('#renameInstanceInput').focus();
  }finally{button.disabled=false;}
};
$('#deleteInstanceCancel').onclick=closeDeleteInstanceDialog;
$('#deleteInstanceConfirm').onclick=confirmDeleteInstance;
$('#deleteInstanceDialog').onclick=event=>{
  if(event.target.id==='deleteInstanceDialog')closeDeleteInstanceDialog();
};
$('#deleteInstanceFinalCancel').onclick=closeDeleteInstanceDialog;
$('#deleteInstanceFinalConfirm').onclick=performDeleteInstance;
$('#deleteInstanceFinalDialog').onclick=event=>{
  if(event.target.id==='deleteInstanceFinalDialog')closeDeleteInstanceDialog();
};
window.addEventListener('keydown',event=>{
  if(event.key==='Escape'&&!$('#createInstanceDialog').hidden)closeCreateInstanceDialog();
  if(event.key==='Enter'&&!$('#createInstanceDialog').hidden&&document.activeElement!==$('#createInstanceSave'))createInstance();
  if(event.key==='Escape'&&!$('#resetPlaytimeDialog').hidden)closeResetPlaytimeDialog();
  if(event.key==='Escape'&&!$('#removeProfileDialog').hidden)closeRemoveProfileDialog();
  if(event.key==='Escape'&&!$('#renameInstanceDialog').hidden)closeRenameInstanceDialog();
  if(event.key==='Escape'&&!$('#deleteInstanceDialog').hidden)closeDeleteInstanceDialog();
  if(event.key==='Escape'&&!$('#deleteInstanceFinalDialog').hidden)closeDeleteInstanceDialog();
  if(event.key==='Escape'&&!$('#removeModDialog').hidden)closeRemoveModDialog();
  if(event.key==='Enter'&&!$('#renameInstanceDialog').hidden&&document.activeElement===$('#renameInstanceInput'))$('#renameInstanceSave').click();
});

setupCustomDropdowns();
setupAppTooltips();
window.eclipse.instances.onInstallProgress(updateInstanceInstallProgress);
window.eclipse.instances.onLaunchStatus(updateLaunchStatus);
window.eclipse.mods.onInstallProgress(updateModInstallProgress);
window.addEventListener('error',event=>window.eclipse.diagnostics.reportRendererError({kind:'uncaught error',message:event.message||'Uncaught renderer error',detail:event.error?.stack||`${event.filename||''}:${event.lineno||0}`}));
window.addEventListener('unhandledrejection',event=>window.eclipse.diagnostics.reportRendererError({kind:'unhandled rejection',message:event.reason?.message||String(event.reason||'Unhandled promise rejection'),detail:event.reason?.stack||''}));
init();
