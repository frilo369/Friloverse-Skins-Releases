// Run by verify-firewall.mjs. Loads the real guide page the way the app does.
const {app,BrowserWindow}=require('electron');
const path=require('node:path');
const os=require('node:os');
const {quietNetwork}=require(path.join(process.env.FRILOVERSE_PROJECT,'src','network-quiet.cjs'));
app.setPath('userData',process.env.FRILOVERSE_FIREWALL_USER_DATA||path.join(os.tmpdir(),`friloverse-firewall-check-${process.pid}`));
if(process.env.FRILOVERSE_FIREWALL_UNPROTECTED!=='yes')quietNetwork(app);
app.whenReady().then(async()=>{
  const win=new BrowserWindow({show:false,width:1400,height:900,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true,partition:'firewall-check'}});
  win.webContents.session.setPermissionRequestHandler((_contents,_permission,callback)=>callback(false));
  await win.loadURL(process.env.FRILOVERSE_FIREWALL_URL).catch(error=>console.log(`load failed: ${error.message}`));
  await new Promise(resolve=>setTimeout(resolve,30000));
  console.log(`page: ${win.getTitle()}`);
  app.exit(0);
});
