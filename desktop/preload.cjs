const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('gateway', {
  check: (path) => ipcRenderer.invoke('gateway:check', path),
  start: () => ipcRenderer.invoke('gateway:start'),
  stop: () => ipcRenderer.invoke('gateway:stop'),
  login: () => ipcRenderer.invoke('gateway:login'),
  baseURL: `http://127.0.0.1:${process.env.PORT || '3010'}`
});
