const {BrowserWindow,ipcMain,session,globalShortcut,screen}=require('electron');
const fs=require('node:fs/promises');
const path=require('node:path');
const {AltTabReturn,altTabPlan}=require('./alt-tab-return.cjs');

const dir=path.join(__dirname,'ui','guide');
const assets=new Map([
  ['mayhem.html','text/html; charset=utf-8'],['mayhem.js','text/javascript; charset=utf-8'],
  ['mayhem-ipc.mjs','text/javascript; charset=utf-8'],['mayhem-data.mjs','text/javascript; charset=utf-8'],
  ['mayhem-cache.mjs','text/javascript; charset=utf-8'],['mayhem.css','text/css; charset=utf-8'],
  ['guide-theme.css','text/css; charset=utf-8'],['mayhem-catalogue.json','application/json; charset=utf-8'],
]);
const adCss='[data-playwire-ads-target="slot"],[data-pw-units],[id^="sky_rect"],[id^="google_ads"],ins.adsbygoogle,iframe[src*="googlesyndication"],iframe[src*="doubleclick"],iframe[src*="playwire"]{display:none!important;height:0!important;min-height:0!important;max-height:0!important;width:0!important;min-width:0!important;max-width:0!important;margin:0!important;padding:0!important;border:0!important;overflow:hidden!important}';
function localMayhem(value){try{const u=new URL(value);return u.protocol==='friloverse-guide:'&&u.hostname==='local'&&!u.username&&!u.password&&!u.port&&u.pathname==='/mayhem.html';}catch{return false;}}
function metaURL(value){try{const u=new URL(value);return u.protocol==='https:'&&u.hostname==='www.metasrc.com'&&!u.username&&!u.password&&!u.port;}catch{return false;}}
/** friloverse-guide://local/art/<path below League's game data>: the path, or null. */
function artRequest(value){
  try{const u=new URL(value);
    return u.protocol==='friloverse-guide:'&&u.hostname==='local'&&!u.username&&!u.password&&!u.port&&!u.search&&u.pathname.startsWith('/art/')?decodeURIComponent(u.pathname.slice(5)):null;
  }catch{return null;}
}
function assetRequest(value){
  try{const u=new URL(value),name=u.pathname.slice(1);
    return u.protocol==='friloverse-guide:'&&u.hostname==='local'&&!u.username&&!u.password&&!u.port&&assets.has(name)?name:null;
  }catch{return null;}
}

class GuideController{
  constructor({app,tracker,champions,guideTarget,guideReady,parseShortcut,systemHotkeyWord,MayhemData,onStatus=()=>{},preview=false}){
    Object.assign(this,{app,tracker,champions,guideTarget,guideReady,parseShortcut,systemHotkeyWord,onStatus,preview});
    this.data=new MayhemData(path.join(app.getPath('userData'),'mayhem-guide'));
    this.sighting={phase:'',mode:null,champion:null};this.current=null;this.binding=null;this.registered='';this.capture=false;this.win=null;this.key='';this.lastOpen=0;this.keyWasDown=false;this.activationFailed=false;
  }
  async initialize(){
    this.partition=this.preview?'friloverse-guide-preview':'persist:friloverse-guide';
    this.guideSession=session.fromPartition(this.partition);
    // Game pictures and the English lists come from the installed League first (9.5), so a
    // CommunityDragon outage leaves the guide whole; the page falls back to CommunityDragon itself.
    const {LeagueIcons}=await import('./league-icons.mjs');
    const league=new LeagueIcons();
    this.data.local=async name=>{const file=await league.gameFile(`v1/${name}`);return file?JSON.parse(file.bytes.toString('utf8')):null;};
    this.guideSession.protocol.handle('friloverse-guide',async request=>{
      const art=artRequest(request.url);
      if(art&&request.method==='GET'){
        const file=await league.gameFile(art).catch(()=>null);
        return file&&!file.type.startsWith('application/')?new Response(file.bytes,{headers:{'Content-Type':file.type,'Cache-Control':'max-age=86400','X-Content-Type-Options':'nosniff'}}):new Response('Not found',{status:404});
      }
      const name=assetRequest(request.url);if(!name||request.method!=='GET')return new Response('Not found',{status:404});
      try{return new Response(await fs.readFile(path.join(dir,name)),{headers:{'Content-Type':assets.get(name),'X-Content-Type-Options':'nosniff'}});}
      catch{return new Response('Not found',{status:404});}
    });
    const [factory,template,mayhemCss,theme,metaCss]=await Promise.all(['metasrc-guide.js','mayhem.html','mayhem.css','guide-theme.css','metasrc-guide.css'].map(f=>fs.readFile(path.join(dir,f),'utf8')));
    const options={template,style:[mayhemCss,theme,metaCss].join('\n'),champions:this.champions.map(c=>({name:c.name,slug:String(c.name).toLowerCase().replace(/[^a-z0-9 -]/g,'').trim().replace(/[ -]+/g,'-')}))};
    this.metaScript=`(${factory.trim().replace(/;$/,'')}).install(${JSON.stringify(options)});`;
    ipcMain.handle('guide-data',async(event,command,args)=>{
      if(!this.win||event.sender!==this.win.webContents||event.senderFrame!==event.sender.mainFrame||!localMayhem(event.senderFrame.url))throw new Error('Unknown guide window.');
      try{
        if(command==='mayhem_guide')return {ok:true,value:await this.data.guide(args?.championId,args?.forceRefresh??false)};
        if(command==='mayhem_catalogue')return {ok:true,value:await this.data.catalogue()};
        throw new Error('Unknown guide request.');
      }catch(error){return {ok:false,error:{detail:String(error.message||error)}};}
    });
  }
  setShortcut(value){
    const binding=this.parseShortcut(value);if(!binding)throw new Error('Choose a supported key or combination.');
    this.binding=binding;this.updateHotkey();
  }
  setCapture(value){this.capture=!!value;this.updateHotkey();}
  // Read on every 8 ms key poll during a game, so it is computed once per sighting.
  target(){return this.current;}
  stopHotkey(){
    if(this.registered){globalShortcut.unregister(this.registered);this.registered='';}
    if(this.keyTimer){clearInterval(this.keyTimer);this.keyTimer=null;}
    if(this.system){this.system.disarm();this.system.restore(this.previousForeground);this.system.destroy();this.system=null;}
    this.systemArmed=false;this.systemBlocked=false;this.previousForeground=null;this.keyWasDown=false;this.altTab=null;
  }
  updateHotkey(){
    this.stopHotkey();
    const enabled=!this.capture&&this.binding&&this.target();
    if(enabled&&!this.preview){
      this.keyWasDown=this.tracker.keyDown(this.binding.key);
      try{if(globalShortcut.register(this.binding.accelerator,()=>{
        const retry=this.keyWasDown&&this.activationFailed;
        if(!this.keyWasDown||retry)this.open({retry});
        this.keyWasDown=true;
      }))this.registered=this.binding.accelerator;}catch{}
      const word=this.systemHotkeyWord?.(this.binding);
      if(word!==null&&word!==undefined){this.system=this.tracker.createSystemHotkey();this.systemWord=word;}
      if(this.tracker.focusGame)this.altTab=new AltTabReturn({altDown:()=>this.tracker.keyDown(0x12),tabDown:()=>this.tracker.keyDown(9),foreground:()=>this.tracker.foregroundSnapshot(),isSwitcher:w=>this.tracker.isSwitcher(w),planFor:from=>this.altTabPlan(from)});
      this.keyTimer=setInterval(()=>this.pollHotkey(),8);
    }
  }
  altTabPlan(from){
    const t=this.tracker,win=this.win,guideOpen=!!win&&!win.isDestroyed()&&win.isVisible()&&!win.isMinimized();
    return altTabPlan(from,{guideOpen,ownPid:process.pid,isGame:w=>t.isGame(w),isGuide:w=>t.sameHandle(w,win.getNativeWindowHandle()),clientKind:id=>t.clientKind(id),
      toGame:()=>t.focusGame(),toGuide:()=>{if(this.win===win&&!win.isDestroyed())t.focusGuide(win.getNativeWindowHandle());}});
  }
  pollHotkey(){
    if(this.capture||!this.binding||!this.target())return;
    this.altTab?.poll();
    const down=this.tracker.keyDown(this.binding.key);
    const helper=this.system?.isForeground()===true;
    if(helper){
      this.system.disarm();this.systemArmed=false;
      // A system activation may arrive after polling. Retry only while the
      // helper itself still owns focus; never pull the user back from League.
      if(!this.open({retry:true}))this.system.restore(this.previousForeground);
    }else{
      const current=this.tracker.foregroundSnapshot();
      if(current?.pid&&current.pid!==process.pid)this.previousForeground=current;
      if(this.systemArmed&&(!current||current.pid===process.pid)){this.system.disarm();this.systemArmed=false;}
      if(this.system&&!this.systemArmed&&!this.systemBlocked&&current?.pid&&current.pid!==process.pid&&!down){
        this.systemArmed=this.system.arm(this.systemWord);this.systemBlocked=!this.systemArmed;
      }
      if(down&&!this.keyWasDown&&this.tracker.shortcutDown(this.binding))this.open();
    }
    this.keyWasDown=down;
  }
  observe(sighting){
    const wasReady=!!this.target();this.sighting=sighting;this.current=this.guideTarget(sighting,this.champions);
    const target=this.target();
    if(wasReady!==!!target)this.updateHotkey();
    if(!target){this.close();return;}
    const key=`${target.mode}:${target.champion}`;
    if(key!==this.key&&!(this.win&&!this.win.isDestroyed()&&this.win.isVisible())){this.close();this.create(target);}
  }
  create(target){
    const key=`${target.mode}:${target.champion}`,local=target.mode==='mayhem';
    const work=screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    const win=new BrowserWindow({x:work.x,y:work.y,width:work.width,height:work.height,show:false,backgroundColor:'#020c17',
      title:local?'Friloverse · ARAM: Mayhem':'Friloverse · MetaSRC',autoHideMenuBar:true,
      webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false,partition:this.partition,...(local?{preload:path.join(__dirname,'guide-preload.cjs')}:{})}});
    this.win=win;this.key=key;
    win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
    win.webContents.session.setPermissionRequestHandler((_contents,_permission,callback)=>callback(false));
    // A server's redirect is a navigation too: it may not lead off the guide's own pages.
    const stayOnGuide=(event,url)=>{if(local?!localMayhem(url):!metaURL(url))event.preventDefault();};
    win.webContents.on('will-navigate',stayOnGuide);
    win.webContents.on('will-redirect',(event,url,_inPlace,isMainFrame)=>{if(event.isMainFrame??isMainFrame)stayOnGuide(event,event.url??url);});
    if(!local){
      win.webContents.on('dom-ready',()=>{
        if(!metaURL(win.webContents.getURL()))return;
        void win.webContents.insertCSS(adCss).catch(()=>{});
        void win.webContents.executeJavaScript(this.metaScript).catch(()=>{});
      });
    }
    if(process.platform==='win32')try{this.tracker.disableTransitions?.(win.getNativeWindowHandle());}catch{}
    // A source that failed while hidden (offline at load time) is retried when opened.
    win.failed=false;
    win.webContents.on('did-fail-load',(_event,code,_description,_url,mainFrame)=>{if(mainFrame&&code!==-3)win.failed=true;});
    win.webContents.on('did-finish-load',()=>{win.failed=false;});
    win.on('close',()=>{
      // The player closed the guide: go back to the game they opened it from.
      if(this.win===win&&win.isVisible()&&process.platform==='win32')try{this.tracker.returnTo?.(this.openedFrom);}catch{}
    });
    win.on('closed',()=>{
      if(this.win!==win)return;
      this.win=null;this.key='';
      // Prepare the next guide at once so a later F1 shows a loaded page.
      setImmediate(()=>{const next=this.target();if(next&&!this.win&&!this.disposed)this.create(next);});
    });
    this.loaded=win.loadURL(target.url).catch(()=>{});
  }
  open({retry=false}={}){
    const target=this.target();if(!target||this.capture)return false;
    const now=Date.now();if(!retry&&now-this.lastOpen<350)return false;this.lastOpen=now;
    const key=`${target.mode}:${target.champion}`;
    if(!this.win||this.win.isDestroyed()||this.key!==key){this.close();this.create(target);}
    const win=this.win;
    if(!this.target()||win!==this.win||win.isDestroyed())return false;
    const from=this.tracker.foregroundSnapshot?.();
    if(from?.pid&&from.pid!==process.pid)this.openedFrom=from;
    else if(!win.isVisible()&&this.previousForeground)this.openedFrom=this.previousForeground;
    if(win.failed){win.failed=false;this.loaded=win.loadURL(target.url).catch(()=>{});}
    if(win.isMinimized())win.restore();
    if(!win.isVisible()){
      // A prepared guide may have been created while another monitor was active.
      // Use the game's current monitor when it is first shown.
      const rect=this.tracker.foregroundRect?.(this.previousForeground);
      if(rect){
        const display=screen.getDisplayMatching(screen.screenToDipRect(null,rect));
        win.setBounds(display.workArea,false);
      }
      // A hidden window is shown already maximized: one step, no restore-size frame.
      win.maximize();
      if(!win.isVisible())win.show();
    }
    if(!win.isMaximized())win.maximize();
    win.focus();
    const activated=process.platform!=='win32'||this.tracker.focusGuide(win.getNativeWindowHandle());
    this.activationFailed=!activated;
    if(!activated)console.warn('Build guide: Windows did not bring the guide to the foreground.');
    return activated;
  }
  close(){
    // Clear first: a programmatic close must not prepare a replacement.
    const win=this.win;this.win=null;this.key='';
    if(win&&!win.isDestroyed())win.destroy();
  }
  dispose(){
    this.disposed=true;this.capture=true;this.stopHotkey();this.close();
    ipcMain.removeHandler('guide-data');this.guideSession.protocol.unhandle('friloverse-guide');
  }
}
module.exports={GuideController,localMayhem,metaURL,assetRequest};
