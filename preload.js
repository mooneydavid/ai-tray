const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ai', {
  getData: () => ipcRenderer.invoke('get-data'),
  getConfig: () => ipcRenderer.invoke('get-config'),
  saveConfig: (config) => ipcRenderer.invoke('save-config', config),
  getAppInfo: () => ipcRenderer.invoke('get-app-info'),
  setStartup: (on) => ipcRenderer.invoke('set-startup', on),
  refresh: () => ipcRenderer.invoke('refresh'),
  quit: () => ipcRenderer.invoke('quit'),
  closeWindow: () => ipcRenderer.invoke('close-window'),
  reAuthenticate: () => ipcRenderer.invoke('re-authenticate'),
  providerLogin: (id) => ipcRenderer.invoke('provider-login', id),
  setHeight: (h) => ipcRenderer.send('set-height', h),
  onDataUpdate: (cb) => ipcRenderer.on('data-update', (_, data) => cb(data)),
  onShowView: (cb) => ipcRenderer.on('show-view', (_, msg) => cb(msg)),
});
