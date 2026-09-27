'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');
const invoke = (method, ...args) => ipcRenderer.invoke(`drift:${method}`, ...args);
const subscribe = (channel, callback) => {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};
contextBridge.exposeInMainWorld('drift', {
  productName: process.argv.includes('--lex-drift-product-name=lex-drift') ? 'lex-drift' : 'DropHarbor',
  getState: () => invoke('getState'),
  refreshHosts: () => invoke('refreshHosts'),
  probeHosts: () => invoke('probeHosts'),
  saveHost: host => invoke('saveHost', host),
  removeHost: id => invoke('removeHost', id),
  enqueueFiles: paths => invoke('enqueueFiles', paths),
  enqueueText: text => invoke('enqueueText', text),
  removeItem: id => invoke('removeItem', id),
  clearItems: () => invoke('clearItems'),
  send: request => invoke('send', request),
  updateSettings: patch => invoke('updateSettings', patch),
  setInteraction: value => invoke('setInteraction', value),
  captureClipboard: () => invoke('captureClipboard'),
  exportConfig: () => invoke('exportConfig'),
  importConfig: () => invoke('importConfig'),
  pickFiles: () => invoke('pickFiles'),
  hideWindow: () => invoke('hideWindow'),
  quit: () => invoke('quit'),
  openSettingsFolder: () => invoke('openSettingsFolder'),
  getFilePath: file => webUtils.getPathForFile(file),
  onState: callback => subscribe('drift:state', callback),
  onReveal: callback => subscribe('drift:reveal', callback),
});
