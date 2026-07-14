const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('sofliaWorker', {
  getStatus: () => ipcRenderer.invoke('app:get-status'),
  link: (input) => ipcRenderer.invoke('app:link', input),
  startWorker: () => ipcRenderer.invoke('app:start-worker'),
  stopWorker: () => ipcRenderer.invoke('app:stop-worker'),
  setCloseToTray: (value) => ipcRenderer.invoke('app:set-close-to-tray', value),
  setTheme: (theme) => ipcRenderer.invoke('app:set-theme', theme),
  quit: () => ipcRenderer.invoke('app:quit'),
  openExternal: (url) => ipcRenderer.invoke('app:open-external', url),
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
