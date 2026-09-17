const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('petAPI', {
  getCharacter: () => ipcRenderer.invoke('pet-get-character'),
  getScale: () => ipcRenderer.invoke('pet-get-scale'),
  move: (dx, dy) => ipcRenderer.send('pet-move', { dx, dy }),
  dragStart: () => ipcRenderer.send('pet-drag-start'),
  dragEnd: (velocity) => ipcRenderer.send('pet-drag-end', velocity || {}),
  interact: () => ipcRenderer.send('pet-interact'),
  openMenu: () => ipcRenderer.send('pet-open-menu'),
  quit: () => ipcRenderer.send('pet-quit'),
  onState: (cb) => {
    const handler = (_e, state) => cb(state);
    ipcRenderer.on('pet-state', handler);
    return () => ipcRenderer.removeListener('pet-state', handler);
  },
  onCharacterChanged: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('pet-character-changed', handler);
    return () => ipcRenderer.removeListener('pet-character-changed', handler);
  },
  onScaleChanged: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('pet-scale-changed', handler);
    return () => ipcRenderer.removeListener('pet-scale-changed', handler);
  },
  onPrepareQuit: (cb) => {
    const handler = () => cb();
    ipcRenderer.on('pet-prepare-quit', handler);
    return () => ipcRenderer.removeListener('pet-prepare-quit', handler);
  },
  onForceUndrag: (cb) => {
    const handler = () => cb();
    ipcRenderer.on('pet-force-undrag', handler);
    return () => ipcRenderer.removeListener('pet-force-undrag', handler);
  },
});

contextBridge.exposeInMainWorld('pickerAPI', {
  getBootstrap: () => ipcRenderer.invoke('picker-bootstrap'),
  start: (characters, remember) =>
    ipcRenderer.send('picker-start', {
      characters: Array.isArray(characters) ? characters : [characters],
      remember,
    }),
  quit: () => ipcRenderer.send('picker-quit'),
});

contextBridge.exposeInMainWorld('sizeAPI', {
  get: () => ipcRenderer.invoke('size-get'),
  set: (percent) => ipcRenderer.send('size-set', percent),
  close: () => ipcRenderer.send('size-close'),
});
