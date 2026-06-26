// HORUS Desktop — preload bridge.
//
// Runs in an isolated context (sandbox: true, contextIsolation: true) and exposes a
// minimal, frozen `window.horus` API to the renderer. This is the only surface the
// web app has into native capabilities; it grows as desktop features land
// (settings store, plugin manager, fs for userData/plugins, etc.).

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('horus', {
  isDesktop: true,
  platform: process.platform,
  version: () => ipcRenderer.invoke('horus:version'),
  getPath: (name) => ipcRenderer.invoke('horus:getPath', name),
  // Persisted settings (userData/settings.json) — backs the renderer settings store.
  settings: {
    getAll: () => ipcRenderer.invoke('settings:getAll'),
    set: (full) => ipcRenderer.invoke('settings:set', full),
  },
  // Restart the app so the embedded engine re-forks with freshly saved API keys.
  relaunch: () => ipcRenderer.invoke('horus:relaunch'),
});
