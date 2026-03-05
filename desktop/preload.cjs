const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('gateway', {
  check: (path) => ipcRenderer.invoke('gateway:check', path),
  start: () => ipcRenderer.invoke('gateway:start'),
  stop: () => ipcRenderer.invoke('gateway:stop'),
  login: () => ipcRenderer.invoke('gateway:login'),
  status: () => ipcRenderer.invoke('gateway:status'),
  getConfig: () => ipcRenderer.invoke('gateway:get-config'),
  setPort: (port) => ipcRenderer.invoke('gateway:set-port', port),
  baseURL: `http://127.0.0.1:${process.env.PORT || '3010'}`
});
