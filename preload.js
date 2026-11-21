'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  readBluetooth: (force) => ipcRenderer.invoke('bt:read', !!force),
  getMaterial: () => ipcRenderer.invoke('material:get'),
  setMaterial: (on) => ipcRenderer.invoke('material:set', !!on),
  updateTray: (payload) => ipcRenderer.send('tray:update', payload),
  notify: (title, body) => ipcRenderer.send('notify', { title, body }),
  resize: (h) => ipcRenderer.send('resize', h),
  getAutostart: () => ipcRenderer.invoke('autostart:get'),
  setAutostart: (on) => ipcRenderer.invoke('autostart:set', on),
  copy: (text) => ipcRenderer.send('clipboard:write', text),
  hide: () => ipcRenderer.send('win:hide'),
  quit: () => ipcRenderer.send('app:quit'),
  onShown: (cb) => ipcRenderer.on('panel:shown', () => cb()),
  onRefresh: (cb) => ipcRenderer.on('refresh', () => cb()),
});
