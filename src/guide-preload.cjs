const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('friloverseGuide',{
  invoke:(command,args)=>ipcRenderer.invoke('guide-data',command,args),
});
