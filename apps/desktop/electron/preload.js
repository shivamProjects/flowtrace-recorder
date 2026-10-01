const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('flowTraceDesktop', {
  isDesktop: true
});
