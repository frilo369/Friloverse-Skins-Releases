const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('friloverse', {
  action: (kind, id) => ipcRenderer.invoke('action', { kind, id }),
  ready: () => ipcRenderer.invoke('ready'),
  partyIcons: () => ipcRenderer.invoke('party-icons'),
  onState: callback => ipcRenderer.on('state', (_event, state) => callback(state))
});
