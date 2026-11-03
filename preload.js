const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ai', {
  getData: () => ipcRenderer.invoke('get-data'),
  getConfig: () => ipcRenderer.invoke('get-config'),
  saveConfig: (config) => ipcRenderer.invoke('save-config', config),
  refresh: () => ipcRenderer.invoke('refresh'),
  openSettings: () => ipcRenderer.invoke('open-settings'),
  quit: () => ipcRenderer.invoke('quit'),
  closeWindow: () => ipcRenderer.invoke('close-window'),
  reAuthenticate: () => ipcRenderer.invoke('re-authenticate'),
  providerLogin: (id) => ipcRenderer.invoke('provider-login', id),
  setHeight: (h) => ipcRenderer.send('set-height', h),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  onDataUpdate: (cb) => ipcRenderer.on('data-update', (_, data) => cb(data)),
});
