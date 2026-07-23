const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('sofliaWorker', {
  getStatus: () => ipcRenderer.invoke('app:get-status'),
  link: (input) => ipcRenderer.invoke('app:link', input),
  clearLink: () => ipcRenderer.invoke('app:clear-link'),
  startWorker: () => ipcRenderer.invoke('app:start-worker'),
  stopWorker: () => ipcRenderer.invoke('app:stop-worker'),
  setApiUrl: (apiUrl) => ipcRenderer.invoke('app:set-api-url', apiUrl),
  setPowerProfile: (powerProfile) => ipcRenderer.invoke('app:set-power-profile', powerProfile),
  setLocalRetentionPolicy: (policy) => ipcRenderer.invoke('app:set-local-retention-policy', policy),
  setCloseToTray: (value) => ipcRenderer.invoke('app:set-close-to-tray', value),
  setTheme: (theme) => ipcRenderer.invoke('app:set-theme', theme),
  getUpdateStatus: () => ipcRenderer.invoke('app:get-update-status'),
  checkForUpdates: () => ipcRenderer.invoke('app:check-for-updates'),
  downloadUpdate: () => ipcRenderer.invoke('app:download-update'),
  installUpdate: () => ipcRenderer.invoke('app:install-update'),
  quit: () => ipcRenderer.invoke('app:quit'),
  openExternal: (url) => ipcRenderer.invoke('app:open-external', url),
  onUpdateStatus: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('app:update-status', listener);
    return () => ipcRenderer.removeListener('app:update-status', listener);
  },
  onSettings: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('app:settings', listener);
    return () => ipcRenderer.removeListener('app:settings', listener);
  },
  onWorkerEvent: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('worker:event', listener);
    return () => ipcRenderer.removeListener('worker:event', listener);
  },
});
