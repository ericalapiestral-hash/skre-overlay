// 영역 고르기 창이 쓸 최소한의 통로.
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('picker', {
  onInit: (fn) => ipcRenderer.on('picker:init', (_e, data) => fn(data)),
  done: (region) => ipcRenderer.send('picker:done', region),
  cancel: () => ipcRenderer.send('picker:cancel'),
});
