const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('eclipse', {
  app: {
    version: () => ipcRenderer.invoke('app:version')
  },
  community: {
    open: destination => ipcRenderer.invoke('community:open', destination)
  },
  updates: {
    onAvailable: callback => {
      const listener = (_, version) => callback(version);
      ipcRenderer.on('updates:available', listener);
      return () => ipcRenderer.removeListener('updates:available', listener);
    },
    onReady: callback => {
      const listener = (_, version) => callback(version);
      ipcRenderer.on('updates:ready', listener);
      return () => ipcRenderer.removeListener('updates:ready', listener);
    },
    install: () => ipcRenderer.invoke('updates:install'),
    pendingChangelog: () => ipcRenderer.invoke('updates:pending-changelog')
  },
  window: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    maximize: () => ipcRenderer.invoke('window:maximize'),
    close: () => ipcRenderer.invoke('window:close'),
    onActivity: callback => {
      const listener = (_, active) => callback(active);
      ipcRenderer.on('window:activity', listener);
      return () => ipcRenderer.removeListener('window:activity', listener);
    }
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: patch => ipcRenderer.invoke('settings:set', patch)
  },
  accounts: {
    addOffline: name => ipcRenderer.invoke('profile:add-offline', name),
    select: profileId => ipcRenderer.invoke('profile:select', profileId),
    remove: profileId => ipcRenderer.invoke('profile:remove', profileId),
    setNote: (profileId, note) => ipcRenderer.invoke('profile:set-note', profileId, note),
    skinUrl: profileId => ipcRenderer.invoke('profile:skin-url', profileId),
    skinData: profileId => ipcRenderer.invoke('profile:skin-data', profileId),
    downloadSkin: profileId => ipcRenderer.invoke('profile:download-skin', profileId),
    beginMicrosoftLogin: () => ipcRenderer.invoke('accounts:begin-microsoft-login'),
    completeMicrosoftLogin: callbackUrl => ipcRenderer.invoke('accounts:complete-microsoft-login', callbackUrl),
    openRegistration: () => ipcRenderer.invoke('accounts:open-registration')
  },
  background: {
    choose: () => ipcRenderer.invoke('background:choose')
  },
  instances: {
    list: () => ipcRenderer.invoke('instances:list'),
    versions: loader => ipcRenderer.invoke('instances:versions', loader),
    performanceOptions: (version, loader) => ipcRenderer.invoke('performance:options', version, loader),
    utilityOptions: (version, loader) => ipcRenderer.invoke('utility:options', version, loader),
    eclipseCustomizationOptions: (version, loader) => ipcRenderer.invoke('eclipse-customization:options', version, loader),
    tlSkinOptions: (version, loader) => ipcRenderer.invoke('tlskins:options', version, loader),
    create: options => ipcRenderer.invoke('instance:create', options),
    chooseModpack: () => ipcRenderer.invoke('instance:choose-modpack'),
    importModpack: (folder, mode, addEclipseTheme) => ipcRenderer.invoke('instance:import-modpack', folder, mode, addEclipseTheme),
    install: folder => ipcRenderer.invoke('instance:install', folder),
    deleteFiles: folder => ipcRenderer.invoke('instance:delete-files', folder),
    resetPlaytime: folder => ipcRenderer.invoke('instance:reset-playtime', folder),
    onInstallProgress: callback => {
      const listener = (_, progress) => callback(progress);
      ipcRenderer.on('instance:install-progress', listener);
      return () => ipcRenderer.removeListener('instance:install-progress', listener);
    },
    onLaunchStatus: callback => {
      const listener = (_, status) => callback(status);
      ipcRenderer.on('instance:launch-status', listener);
      return () => ipcRenderer.removeListener('instance:launch-status', listener);
    },
    rename: (folder, name, icon, group) => ipcRenderer.invoke('instance:rename', folder, name, icon, group),
    launch: instance => ipcRenderer.invoke('instance:launch', instance)
  },
  mods: {
    list: folder => ipcRenderer.invoke('mods:list', folder),
    openFolder: (folder, assetType) => ipcRenderer.invoke('mods:open-folder', folder, assetType),
    listAssets: (folder, assetType) => ipcRenderer.invoke('mods:assets-list', folder, assetType),
    removeAsset: (folder, fileName, assetType) => ipcRenderer.invoke('mods:assets-remove', folder, fileName, assetType),
    installAsset: (folder, projectId, assetType) => ipcRenderer.invoke('mods:assets-install', folder, projectId, assetType),
    setEnabled: (folder, fileName, enabled) => ipcRenderer.invoke('mods:set-enabled', folder, fileName, enabled),
    remove: (folder, fileName) => ipcRenderer.invoke('mods:remove', folder, fileName),
    search: (folder, query, options) => ipcRenderer.invoke('mods:search', folder, query, options),
    install: (folder, projectId) => ipcRenderer.invoke('mods:install', folder, projectId),
    onInstallProgress: callback => {
      const listener = (_, progress) => callback(progress);
      ipcRenderer.on('mods:install-progress', listener);
      return () => ipcRenderer.removeListener('mods:install-progress', listener);
    }
  },
  news: {
    list: options => ipcRenderer.invoke('news:list', options),
    open: url => ipcRenderer.invoke('news:open', url)
  },
  diagnostics: {
    list: () => ipcRenderer.invoke('diagnostics:list'),
    read: id => ipcRenderer.invoke('diagnostics:read', id),
    deleteCrashReport: id => ipcRenderer.invoke('diagnostics:delete-crash-report', id),
    reportRendererError: report => ipcRenderer.send('diagnostics:renderer-error', report)
  }
});
