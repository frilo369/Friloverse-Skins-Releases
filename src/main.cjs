const { app, BrowserWindow, ipcMain, screen, clipboard, dialog, Tray, Menu, nativeImage, autoUpdater, protocol, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const {existsSync}=require('node:fs');
const preview = process.argv.includes('--preview');
protocol.registerSchemesAsPrivileged([{scheme:'friloverse-guide',privileges:{standard:true,secure:true,supportFetchAPI:true}},{scheme:'friloverse-icon',privileges:{standard:true,secure:true}}]);
// A plain setup starts the app with its first-run flag: stay in the tray for that too.
const firstRun = process.argv.includes('--squirrel-firstrun');
let startup = process.argv.includes('--startup')||firstRun;
// Started with Windows, the heavy background work waits: the PC has enough to do at that moment.
const WINDOWS_START = process.argv.includes('--startup');
// The first check (the app, then the databases) waits for the setup or update that may have just started this copy.
const FIRST_CHECK_AFTER = WINDOWS_START?45*1000:15*1000;
const screenshotDir = process.argv.find(arg=>arg.startsWith('--screenshots='))?.slice(14);
if(preview)app.setPath('userData',path.join(app.getPath('temp'),'friloverse-isolated-preview'));
let resumedFromUpdate=false,resumeAt=null,foregroundLeftAt=0,notedChampionLoss=0,panelSeen='',panelHiddenBy='',lastClient=null;
const FOREGROUND_GRACE=700;
const errorLog=require('./error-log.cjs').createErrorLog({dir:app.getPath('userData'),version:app.getVersion()});
const windowsAccount=process.platform==='win32'?require('./windows-account.cjs'):null;
const elevation=require('./elevation.cjs');
process.on('uncaughtException',error=>{try{errorLog.failed('uncaught',error);}catch{}});
process.on('unhandledRejection',reason=>{try{errorLog.failed('unhandled-rejection',reason instanceof Error?reason:new Error(String(reason)));}catch{}});
const {PollGate,oneTimer,stillThere,retryDelay,finishWithin,rotatingLog}=require('./run-guards.cjs');
// One League request that never returns must not end the panel for the rest of the session.
const polls=new PollGate({onStuck:()=>errorLog.note('panel','a look at League took over 30 s; starting a new one')});
const riotRetry=oneTimer(()=>{void checkRiotSkins();});
const ltkPresence=stillThere(()=>resolveLtkExecutable());
// Check for updates and Check databases close Settings, so their answer also shows on the status line for a while.
const CHECK_RESULT_SHOWN=15000;
const checkResultExpiry=oneTimer(()=>{state.checkResult='';emitState();});
function showCheckResult(text){state.checkResult=text;checkResultExpiry.set(CHECK_RESULT_SHOWN);}
// How long quitting may wait for the party and LTK to be put back. The next start finishes what this did not.
const QUIT_LIMIT=20000;
let lastSkinClick='';
app.setAppUserModelId('com.squirrel.friloverse-skins.Friloverse-Skins');
require('./network-quiet.cjs').quietNetwork(app);
// Divinity's install moves itself across once (old-name.cjs). Installed copies only: never a preview or a dev run.
const oldName=app.isPackaged&&!preview&&process.platform==='win32'?require('./old-name.cjs'):null;
const passingThrough=Boolean(oldName?.insideOldInstall(process.execPath));
// Squirrel may remove the install root after its event returns. Preserve old libraries
// before loading its event handler, which schedules app.quit(). Normal starts migrate below.
if(!passingThrough&&!preview&&process.argv.includes('--squirrel-uninstall')){
  try{require('./database-location.cjs').migrateDatabase(process.env.LOCALAPPDATA);}
  catch(error){dialog.showErrorBox('Your skin database could not be moved',`${error.message}\nCopy the Database folder out of the install folder before uninstalling.`);app.exit(1);}
}
const squirrelEvent=!passingThrough&&!preview&&process.platform==='win32'&&require('electron-squirrel-startup');
if(passingThrough)oldName.oldInstallEvent(app);
else if(squirrelEvent){
  if(process.argv.includes('--squirrel-uninstall')){
    app.setLoginItemSettings({name:'Friloverse Skins',openAtLogin:false});
    // Best effort: a task made with the highest rights may need an elevated uninstall to go; left over, it only fails quietly.
    try{require('node:child_process').spawnSync('schtasks.exe',['/Delete','/TN','Friloverse Skins','/F'],{windowsHide:true,timeout:10000});}catch{/* Nothing to remove. */}
  }
  // The first normal start of this version tries again if LTK Manager was open.
  else if(process.argv.some(arg=>arg==='--squirrel-install'||arg==='--squirrel-updated')){
    try{require('./ltk-preference.cjs').applyPreference();}catch{/* The first normal start tries again. */}
  }
}else if(elevation.shouldElevate({packaged:app.isPackaged,preview,elevated:windowsAccount?windowsAccount.processElevated(process.pid):null})){
  // Friloverse runs as administrator (src/elevation.cjs). Nothing here has taken the single-instance
  // lock yet, so the elevated copy can. Declining the prompt carries on unelevated.
  elevation.relaunchElevated().then(started=>{
    if(started)app.exit(0);
    else{errorLog.note('elevation','administrator rights were not given; running without them');startNormally();}
  });
}else startNormally();
function startNormally(){
  if(leaveOldName(),!app.requestSingleInstanceLock({preview})){app.quit();return;}
  app.on('second-instance', (_event,args) => {
    if(args.includes('--startup'))return;
    // A shortcut double-click during startup must open when the window exists.
    if(dashboard&&!dashboard.isDestroyed())showDashboard();else showWhenReady=true;
  });
  app.whenReady().then(start).catch(error => {
    console.error('Friloverse startup failed:',error.stack||error.message);
    if(!preview)dialog.showErrorBox('Friloverse could not start',String(error.message||error));
    app.exit(1);
  });
}
let dashboard, overlay, launcher, nextLauncherRaise=0, launcherPlaced='', bridge, engine, tracker, model, party, database, localDatabase, localSkinsFolders=null, modDatabase, customMods, catalogue, choices, riot, resolveLtkExecutable, leagueClient, ltkFound=false, nextLtkCheck=0, installingLtk=false, customImporting=true, savedDashboard, tray, settingsStore, appUpdater, guide, guideWatcher, outsideClicks, noGameProcess;
let hold,draftVisibility,nextPanelRaise=0,diagnostics,skinHistory,ltkLogTail,rateLimitGuard,lastLeaguePidChecked=0,emergencyModsOff=false,restoredDraftKey='',swiftplaySlot=0;
const stringTableModCache=new Map();
const riotCatalog=new Map(),riotCardsHeld=new Map();
let state = { champion:null, mode:'hidden', skins:[], connected:false, leagueConnected:false, pending:'', error:'', databaseError:'',importError:'',checkResult:'',riotSkinsError:'',riotUpdateStatus:'',patcherError:'', connection:'Waiting for League client', ltkNotice:'', ltkInstalling:false, ltkInstallError:'', patcher:'idle', preview, partyDocked:false, party:null, champions:[], version:'',settings:null,mods:[],modsPending:'',modsError:'',modsNotice:'',appUpdateStatus:'',skinUpdateStatus:'',progress:null,issues:[],restoredSkin:null,diagnosticsBusy:false,diagnosticsStatus:'',swiftplay:null };
let actionBusy = false, timer, lastPayload='', lastDashboard='',nextUpdateAttempt=0;
let checksRunning=null, customImportDone=Promise.resolve(), lastRiotLeftNote='', draftNoted=false;
let riotChecking=false, riotFetching=false, riotFetchRetry=null, riotHourly=null, riotFiveMinute=null, collectionSyncing=false, collectionRetry=null, collectionRestoreQueued=false, collectionLimitedRuns=0, collectionLimitSaid='';
let closed=false,quitting=false,quitReady=false,updating=false,showWhenReady=false;
const imageCache = new Map();

// Friloverse never has a taskbar button; the tray and the League icon open it.
function revealDashboard(){
  if(dashboard.isMinimized())dashboard.restore();
  dashboard.show();dashboard.setSkipTaskbar(true);dashboard.focus();
  // The League icon never takes focus, so Windows may refuse a plain request.
  if(!preview&&process.platform==='win32')try{tracker.focusGuide(dashboard.getNativeWindowHandle());}catch{}
}
let dashboardMoved=false;
function showDashboard(){
  if(!dashboard||dashboard.isDestroyed())return;
  if(state.partyDocked)restoreDashboard();
  const client=tracker?.clientWindow();
  if(client&&!dashboardMoved)dashboard.setPosition(...Object.values(model.centeredOn(screen.screenToDipRect(null,client),dashboard.getBounds())),false);
  revealDashboard();
  emitState();syncOutsideClicks();
}
function restoreDashboard({raise=true}={}){
  if(!state.partyDocked||!dashboard||dashboard.isDestroyed())return;
  state.partyDocked=false;dashboard.setAlwaysOnTop(false);
  if(savedDashboard?.bounds)dashboard.setBounds(savedDashboard.bounds);
  const saved=savedDashboard;savedDashboard=null;
  if(!saved?.visible)dashboard.hide();
  else if(raise){dashboard.showInactive();dashboard.setSkipTaskbar(true);}
}
function dockDashboard(){
  const client=tracker.clientWindow()||lastClient;
  if(!client)return false;
  const r=screen.screenToDipRect(null,client);
  const height=Math.round(r.height*.775),width=Math.min(Math.round(height*1672/941),Math.round(r.width*.9));
  dashboard.setBounds({x:Math.round(r.x+(r.width-width)/2),y:Math.round(r.y+r.height*.105),width,height});
  return true;
}
// Apply visibility before async skin reads and on the guard's first freeze. Delayed
// polls and window-placement ticks cannot bring a finished draft back onto the screen.
function syncDraftVisibility(){
  if(preview)return true;
  if(!draftVisibility)return false;
  const phase=guideWatcher?.sighting.phase||'';
  const swiftplay=!!guideWatcher?.swiftplay?.active&&(guideWatcher.swiftplay.slots?.length||0)>0;
  const {active,closed:ended}=draftVisibility.observe({phase,connected:!!guideWatcher?.connected,
    frozen:!!hold?.frozenOnce&&hold.phase===phase,run:hold?.guardRun,
    reconnect:!!hold?.reconnectWindow&&!hold.frozen,swiftplay});
  if(ended)clearForGame();
  return active;
}
function hideDashboard(){
  if(!dashboard||dashboard.isDestroyed())return;
  if(state.partyDocked)restoreDashboard();
  dashboard.hide();emitState();syncOutsideClicks();
}
function syncOutsideClicks(){
  if(!outsideClicks)return;
  if(state.partyDocked&&dashboard&&!dashboard.isDestroyed()&&dashboard.isVisible())outsideClicks.watch(dashboard);
  else if(state.mode==='open'&&overlay&&!overlay.isDestroyed()&&overlay.isVisible())outsideClicks.watch(overlay);
  else outsideClicks.stop();
}
function trayIcon(){
  return nativeImage.createFromPath(path.join(__dirname,'ui','friloverse.ico'));
}
// Before the data folder is in use: its files have to move into place first.
function leaveOldName(){
  if(!oldName)return;
  try{
    // Every start: the old copy may have done the move itself and left this entry behind.
    oldName.forgetOldLogin(app);
    if(!oldName.moveOldInstall({desktop:app.getPath('desktop')}))return;
    setTimeout(()=>{try{oldName.finishOldInstall();}catch(error){console.error('Removing the old install:',error.message);}},30000);
  }
  catch(error){console.error('Moving the old install:',error.message);}
}
function configureLogin(){
  if(!app.isPackaged||preview)return;
  const base=path.resolve(path.dirname(process.execPath),'..');
  const stub=path.join(base,'Friloverse-Skins.exe');
  const executable=existsSync(path.join(base,'Update.exe'))&&existsSync(stub)?stub:process.execPath;
  const wanted=state.settings.startWithWindows;
  // Elevated, Friloverse starts through a logon task with the highest rights: Windows does not start
  // a Run-key program that needs the consent prompt (src/startup-task.cjs). Unelevated, the Run entry stays.
  if(windowsAccount?.processElevated(process.pid)===true){
    require('./startup-task.cjs').syncTask({exe:executable,enabled:wanted}).then(
      result=>{if(result==='created')errorLog.note('startup','logon task created');},
      error=>errorLog.note('startup',`logon task could not be updated: ${error.message}`));
    const off={name:'Friloverse Skins',path:executable,args:['--startup'],openAtLogin:false};
    app.setLoginItemSettings(off);
    return;
  }
  const options={name:'Friloverse Skins',path:executable,args:['--startup'],openAtLogin:wanted};
  app.setLoginItemSettings(options);
  if(app.getLoginItemSettings(options).openAtLogin!==options.openAtLogin)throw new Error('Windows could not update Friloverse startup.');
}

function windowOptions(extra={}) {
  return { backgroundColor:'#07121b', webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}, ...extra };
}
function lockWindow(win) {
  win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  win.webContents.on('will-navigate', event=>event.preventDefault());
}
function emitState() {
  // The Reconnect screen's big wait / safe banner (overlay.js `drawReconnect`).
  if(hold)state.reconnectSafe=hold.reconnectSafe();
  errorLog.shown(state,{skin:lastSkinClick});
  // The champions never change and each window got them from 'ready': this runs several times a second.
  const {champions:_kept,...sent}=state;
  const payload=JSON.stringify(sent);
  if(payload!==lastPayload && overlay && !overlay.isDestroyed()) { overlay.webContents.send('state',sent);lastPayload=payload; }
  if(payload!==lastDashboard && dashboard && !dashboard.isDestroyed()) { dashboard.webContents.send('state',sent);lastDashboard=payload; }
}

// The dashboard's top-left panel lists what is in flight, the most important first (6.0: every
// task, not only the first, and a download's speed and time left). Downloads report many times a
// second, so a task that only moved is redrawn at most every quarter second.
const taskProgress=new Map(),TASK_RANK={ltk:0,app:1,collection:2,skins:3,riot:4,riotFiles:5};
let taskFlush=null;
function setTask(key,value){
  const now=Date.now(),old=taskProgress.get(key);
  if(!value){if(!old)return;taskProgress.delete(key);}
  else{
    // A finished download is not the end (6.7, a player thought 1.5 of 1.5 MB was stuck): it says
    // what comes next, with a moving bar, until the task changes or ends.
    if(value.then&&value.unit==='bytes'&&Number(value.max)>0&&Number(value.value)>=Number(value.max))
      value={...value,label:value.then,detail:value.thenDetail||'',indeterminate:true,unit:undefined,value:0,max:0};
    const next={...value,key,at:now,shownAt:old?.shownAt||0};
    if(value.unit==='bytes'&&Number.isFinite(Number(value.value))){
      const same=old?.unit==='bytes'&&old.label===value.label&&Number(value.value)>=Number(old.value);
      next.sampleAt=same?old.sampleAt:now;next.sampleValue=same?old.sampleValue:Number(value.value);next.rate=same?old.rate:0;
      // Speed over whole seconds, smoothed so the time left does not jump about.
      if(same&&now-old.sampleAt>=1000){
        const sample=(Number(value.value)-old.sampleValue)/((now-old.sampleAt)/1000);
        next.rate=old.rate?old.rate*.7+sample*.3:sample;next.sampleAt=now;next.sampleValue=Number(value.value);
      }
      const left=Number(value.max)-Number(value.value);
      next.eta=next.rate>0&&left>0?Math.round(left/next.rate):null;
    }
    taskProgress.set(key,next);
    const onlyMoved=old&&old.label===next.label&&old.detail===next.detail&&!!old.indeterminate===!!next.indeterminate;
    if(onlyMoved&&now-old.shownAt<250){
      if(!taskFlush){taskFlush=setTimeout(()=>{taskFlush=null;showTasks();},250);taskFlush.unref?.();}
      return;
    }
  }
  showTasks();
}
function showTasks(){
  const now=Date.now();
  const list=[...taskProgress.values()].sort((a,b)=>(TASK_RANK[a.key]??9)-(TASK_RANK[b.key]??9));
  for(const task of list)task.shownAt=now;
  state.tasks=list.slice(0,3).map(({key,label,detail,value,max,indeterminate,unit,rate,eta})=>({key,label,detail,value,max,indeterminate,unit,rate,eta}));
  state.progress=state.tasks[0]||null;
  emitState();
}
let stopUpdateWatch=null;
function appTask(message,{manual=false}={}){
  // An hourly check that finds nothing is not worth a line; a download always is.
  if(/^Checking for app updates/.test(message)){if(manual)setTask('app',{label:'Checking for a Friloverse update',indeterminate:true});}
  else if(/^Downloading app update/.test(message)){
    setTask('app',{label:'Downloading the Friloverse update',indeterminate:true});
    if(!stopUpdateWatch&&appUpdater?.installed){
      let stopped=false,stop=()=>{stopped=true;};
      stopUpdateWatch=()=>stop();
      void import('./update-progress.mjs').then(({watchUpdateDownload})=>{
        if(stopped)return;
        stop=watchUpdateDownload({feed:appUpdater.feed,version:app.getVersion(),
          packagesDir:path.join(path.dirname(path.dirname(process.execPath)),'packages'),
          // Squirrel then builds the new version from the delta and installs it beside this one.
          onProgress:({bytes,total})=>{if(!stopped)setTask('app',{label:'Downloading the Friloverse update',unit:'bytes',value:bytes,max:total,
            then:'Installing the Friloverse update',thenDetail:'Putting the new version in place'});}});
      }).catch(()=>{});
    }
  }
  else if(/update downloaded|up to date|Could not check|no published release|Install Friloverse|Could not apply|feed has no|App update check/.test(message)){
    stopUpdateWatch?.();stopUpdateWatch=null;setTask('app',null);
  }
}

async function start() {
  model=await import('./model.mjs');
  draftVisibility=new model.DraftVisibility();
  const ltk=await import('./ltk.mjs');({resolveLtkExecutable}=ltk);
  const {SkinEngine}=await import('./engine.mjs');
  const {buildNameMod,shipsLanguageTable}=await import('./skin-names.mjs');
  const {PreparedSkinLibrary}=await import('./prepared-skins.mjs');
  const {DiagnosticsStore}=await import('./diagnostics-state.mjs');
  const {SkinHistory}=await import('./skin-history.mjs');
  const {LtkLogTail,checkLtkBuiltins}=await import('./ltk-log-tail.mjs');
  const {RateLimitGuard}=await import('./github-refs.mjs');
  diagnostics=new DiagnosticsStore({dataDir:app.getPath('userData')});
  skinHistory=new SkinHistory(app.getPath('userData'));
  ltkLogTail=new LtkLogTail({ltkDir:path.join(app.getPath('appData'),'dev.leaguetoolkit.manager')});
  rateLimitGuard=new RateLimitGuard(app.getPath('userData'));
  if(!preview){
    state.issues=await diagnostics.load();
    await skinHistory.load();
    await rateLimitGuard.load();
  }
  riot=await import('./riot-skins-local.mjs');
  // 10.6: LTK refuses Riot's own skins in game, so the panel shows no Riot tab.
  state.riotSkinsOff=riot.RIOT_SKINS_OFF;
  leagueClient=await import('./league-client.mjs');
  const {SkinChoices}=await import('./skin-choices.mjs');
  const {CustomMods}=await import('./custom-mods.mjs');
  const {PartyCoordinator}=await import('./party-coordinator.mjs');
  const {SkinDatabase}=await import('./skin-database.mjs');
  const {clientPhaseQuiet}=await import('./league-phase.mjs');
  const {friloverseDatabaseRoot,customSkinsRoot,customModsRoot,importLegacyCustomLibraries,importProblem,loadCustomArtwork}=await import('./custom-database.mjs');
  const {SettingsStore,DEFAULT_SETTINGS}=await import('./settings.mjs');
  const {AppUpdater,shortProblem}=await import('./app-updater.mjs');
  ({noGameProcess}=await import('./lcu-safety.mjs'));
  const {guideTarget,guideReady}=await import('./guide-match.mjs');
  const {parseShortcut,systemHotkeyWord}=await import('./guide-shortcut.mjs');
  const {GuideWatcher}=await import('./guide-lcu.mjs');
  const {MayhemData}=await import('./guide-data.mjs');
  const {OutsideClickWatcher}=await import('./outside-click.mjs');
  const {GuideController}=require('./guide.cjs');
  // The bundled LTF bridge, built from native/ltf: one hidden LTK Manager, started through
  // the launcher, kept open and driven over its injected DLL. No Rose install is needed.
  let ltfBridge=null;
  if(!preview){
    try{
      const ltf=await import('./ltf-bridge.mjs');
      if(await ltf.ltfAvailable()){
        const exePath=await resolveLtkExecutable().catch(()=>null);
        ltfBridge=new ltf.LtfBridge({exePath,logDir:path.join(app.getPath('userData'),'ltf')});
      }
    }catch(error){errorLog.note('ltk',`The LTF bridge could not be loaded: ${error.message}`);}
  }
  bridge=ltfBridge||new ltk.LtkBridge();
  if(ltfBridge){
    // LTK refused Riot's own skins when Friloverse built and patched them the old way. The
    // bundled bridge applies them the way Rose does, so the tab returns; known refusals stay.
    riot.setRiotSkinsOff(false);state.riotSkinsOff=false;
    errorLog.note('ltk','using the bundled LTF bridge for injection');
  }
  tracker=require('./windows.cjs');
  state.version=model.shownVersion(app.getVersion());
  settingsStore=new SettingsStore(app.getPath('userData'));
  try{state.settings=await settingsStore.load();}
  catch{
    // A truncated settings file must not stop the app from starting. Keep it for
    // inspection and use the defaults, as the atomic writer intended.
    try{await fs.rename(settingsStore.file,`${settingsStore.file}.bad-${Date.now()}`);}catch{}
    state.settings={...DEFAULT_SETTINGS};settingsStore.value={...DEFAULT_SETTINGS};
    state.appUpdateStatus='Friloverse settings could not be read; defaults are in use.';
  }
  if(!preview){
    // The complete setup's privacy page leaves a marker when the player declines download reports.
    try{
      const {applyInstallerChoices}=await import('./settings.mjs');
      if(await applyInstallerChoices(settingsStore,app.getPath('userData')))state.settings={...settingsStore.value};
    }catch(error){errorLog.note('settings',`The installer's choices could not be applied: ${error.message}`);}
    const marker=path.join(app.getPath('userData'),'resume-in-tray');
    try{
      const [timestamp,x,y]=(await fs.readFile(marker,'utf8')).split(' ').map(Number);await fs.unlink(marker);
      if(Date.now()-timestamp<120000&&timestamp<=Date.now()){startup=true;resumedFromUpdate=true;if(Number.isInteger(x)&&Number.isInteger(y))resumeAt=[x,y];}
    }catch{}
  }
  state.champions=JSON.parse(await fs.readFile(path.join(__dirname,'ui','champions.json'),'utf8'));
  guide=new GuideController({app,tracker,champions:state.champions,guideTarget,guideReady,parseShortcut,systemHotkeyWord,MayhemData,preview});
  await guide.initialize();guide.setShortcut(state.settings.guideHotkey);
  if(!preview){guideWatcher=new GuideWatcher(sighting=>{guide.observe(sighting);syncDraftVisibility();place();placeLauncher();lookSoon(sighting);});guideWatcher.start();}
  const localAppData=process.env.LOCALAPPDATA||path.join(process.env.USERPROFILE||'','AppData','Local');
  if(!preview)require('./database-location.cjs').migrateDatabase(localAppData);
  const databaseRoot=friloverseDatabaseRoot(localAppData),skinsRoot=customSkinsRoot(localAppData),modsRoot=customModsRoot(localAppData);
  const libraryProblem=({file,problem})=>errorLog.note('library',`could not read ${file}: ${problem}`);
  database=new SkinDatabase({root:skinsRoot,champions:state.champions,onProblem:libraryProblem});
  try{database.setArtwork(await loadCustomArtwork({dataDir:app.getPath('userData'),databaseRoot}));}catch{/* Artwork is optional. */}
  modDatabase=new SkinDatabase({root:modsRoot,mode:'mods',onProblem:libraryProblem});
  // The player's own skins (10.0): a folder per champion, made here and kept up at every start.
  const {localSkinsRoot,ensureLocalSkinFolders}=await import('./local-skins.mjs');
  localDatabase=new SkinDatabase({root:localSkinsRoot(databaseRoot),champions:state.champions,local:true,onProblem:libraryProblem});
  localSkinsFolders=()=>ensureLocalSkinFolders(localDatabase.root,state.champions);
  // A local copy of a collection skin shows the collection's picture too.
  localDatabase.setArtwork(database.artwork);
  customMods=new CustomMods({database:modDatabase,dataDir:app.getPath('userData')});
  // A clean PC should already have the folders the app reads, even before the
  // first GitHub answer, so an empty library is distinguishable from a missing one.
  await Promise.all([
    path.join(databaseRoot,'RiotSkins'),
    skinsRoot,
    modsRoot,
  ].map(folder=>fs.mkdir(folder,{recursive:true}).catch(()=>{})));
  if(!preview)await localSkinsFolders().then(failed=>{if(failed)errorLog.note('library',`could not make ${failed} LocalSkins champion folder(s)`);},
    error=>errorLog.note('library',`could not make the LocalSkins folder: ${error.message}`));
  const {RiotSkinBuilder,registerChampions}=await import('./riot-skin-builder.mjs');
  // Merge any day-0 champions present in the installed League's v1/champion-summary.json so new
  // champions work for Local/Custom/Riot skins before Friloverse ships a new champions.json.
  if(!preview){
    try{
      const {LeagueIcons}=await import('./league-icons.mjs');
      const raw=await new LeagueIcons().gameFile('v1/champion-summary.json');
      const list=raw&&JSON.parse(raw.bytes.toString('utf8'));
      if(Array.isArray(list)){
        const known=new Set(state.champions.map(row=>Number(row.key)));
        let added=0;
        for(const item of list){
          const key=Number(item?.id);
          if(!Number.isSafeInteger(key)||key<=0||key>10000||known.has(key))continue;
          const id=String(item?.alias||'').replace(/[^a-zA-Z0-9]/g,'');
          const name=String(item?.name||'').trim();
          if(!id||!name)continue;
          state.champions.push({key:String(key),id,name});
          known.add(key);added++;
        }
        if(added){registerChampions(state.champions);errorLog.note('panel',`added ${added} day-0 champion(s) from installed League`);}
      }
    }catch{/* Bundled champions.json remains the baseline. */}
  }
  const riotBuilder=new RiotSkinBuilder({cacheDir:path.join(app.getPath('userData'),'built-skins')});
  catalogue=new riot.RiotCatalogue({root:path.join(databaseRoot,'RiotSkins'),onChange:()=>{void checkRiotSkins();},
    // The list's and Riot's names' downloads in MB (6.3); the check before them is one small request.
    onProgress:({what,bytes,total,files,count})=>what==='files'
      ?setTask('riotFiles',{label:'Downloading Riot skin files',unit:'bytes',value:bytes,max:total,indeterminate:!total,detail:`${files} of ${count} files`,
        then:'Checking the downloaded skins',thenDetail:'Each file is checked, then kept'})
      :setTask('riot',{label:what==='names'?'Downloading Riot skin names':'Downloading the Riot skin list',
      unit:'bytes',value:bytes,max:total||0,indeterminate:!total,then:what==='names'?'Reading Riot skin names':'Reading the Riot skin list',
      thenDetail:'Saving it for the skin panel'}),buildSkin:(skin,options)=>riotBuilder.build(skin,options)});
  choices=new SkinChoices({database,localDatabase,catalogue,champions:state.champions});
  const preparedSkins=new PreparedSkinLibrary({dataDir:app.getPath('userData')});
  const anyStringTableMod=async()=>{
    for(const mod of engine?.mods||[]){
      if(!mod?.file)continue;
      let ships=stringTableModCache.get(mod.key);
      if(ships===undefined){ships=await shipsLanguageTable(mod.file).catch(()=>false);stringTableModCache.set(mod.key,ships);}
      if(ships)return true;
    }
    return false;
  };
  const buildNamesProtected=async request=>buildNameMod({...request,keepChampionInChat:true,hasStringTableMod:await anyStringTableMod()});
  const pollLtkVerdicts=async()=>{
    if(preview||!ltkLogTail)return;
    const verdict=await ltkLogTail.poll().catch(()=>null);
    if(!verdict)return;
    for(const item of verdict.findings){
      if(diagnostics?.report(item))errorLog.note('ltk-verdict',`${item.code}: ${item.title} — ${item.detail}`);
    }
    if(verdict.brokenModIds.length&&bridge?.connected&&typeof bridge.toggle==='function'){
      for(const modId of verdict.brokenModIds){
        await bridge.toggle(modId,false).catch(()=>{});
        errorLog.note('ltk-verdict',`auto-disabled broken LTK mod entry ${modId}`);
      }
    }
    if(verdict.findings.length&&diagnostics){state.issues=diagnostics.snapshot();emitState();}
  };
  engine=new SkinEngine({bridge,dataDir:app.getPath('userData'),buildNames:buildNamesProtected,onArmed:ms=>{errorLog.note('ltk',`patcher started during the draft, in ${ms} ms`);void ltkLogTail?.mark();},onChange:()=>{state.patcher=engine.status;state.patcherError=engine.error;void pollLtkVerdicts();emitState();},
    prepareFile:async pick=>{
      const found=await preparedSkins.resolve(pick);
      if(found.prepared===false)errorLog.note('prepare',`${pick.label||'A custom skin'}: ${found.working?'preparing it on the pick':'using its old copy, for LTK to check'}`);
      return found;
    },
    keepPrepared:async(pick,modId)=>preparedSkins.keep(pick,(await bridge.mods()).find(mod=>mod.id===modId)),
    onRetry:message=>errorLog.note('engine',message),
    onSlotFailed:(alias,detail)=>errorLog.note('engine',`${alias||'A skin'}: failed to apply over League's selected skin. ${detail}`)});
  if(!preview){
    try{require('./ltk-preference.cjs').applyForVersion(app.getVersion(),path.join(app.getPath('userData'),'ltk-preference-version.txt'));}
    catch{/* Never a reason not to start. */}
    await (await import('./leftovers.mjs')).removeLeftovers(app.getPath('userData')).catch(error=>errorLog.note('leftovers',error.message));
    await Promise.all([customMods.load(),catalogue.load(),engine.load()]);
    await riotBuilder.clean();
    for(const row of JSON.parse(await fs.readFile(path.join(__dirname,'fryilo-catalog','champions.json'),'utf8')).champions)riotCatalog.set(Number(row.key),row);
    // Bring packages from older FrYiLoCo installs into Friloverse once; leave the source files alone.
    customImportDone=importLegacyCustomLibraries({localAppData,onProgress:(done,total)=>setTask('skins',{label:'Importing custom skins & mods',value:done,max:total,detail:`${done} of ${total} files`})})
      .then(async result=>{
        customImporting=false;
        for(const item of [...result.failed||[],...result.leftOut||[]])errorLog.note('library',`could not import ${item.file}: ${item.problem}`);
        state.importError=importProblem(result);emitState();
        if(result.copied){
          await refreshCustomMods();
          if(state.champion){const row=state.champions.find(item=>model.championKey(item.name)===model.championKey(state.champion));if(row)await refreshSkins(row).catch(()=>{});}
        }
      })
      .catch(error=>{customImporting=false;state.importError=`Custom database import: ${error.message}`;emitState();})
      .finally(()=>{
        setTask('skins',null);
        if(collectionRestoreQueued&&!closed){collectionRestoreQueued=false;state.databaseChecking=false;void checkDatabases();}
        void removeWithdrawn();
      });
  }else customImporting=false;
  // Square corners, so the painted frame reaches them.
  dashboard=new BrowserWindow(windowOptions({roundedCorners:false,width:1280,height:720,minWidth:640,minHeight:360,maximizable:false,title:`Friloverse ${state.version}`,autoHideMenuBar:true,frame:false,show:false,skipTaskbar:true}));
  // The lobby is one picture, so the window keeps its shape.
  dashboard.setAspectRatio(1672/941);
  // A double click on a drag area (the top bar, the version) means maximize to Windows; the lobby never does.
  dashboard.on('maximize',()=>dashboard.unmaximize());
  overlay=new BrowserWindow(windowOptions({width:1076,height:453,frame:false,transparent:true,backgroundColor:'#00000000',show:false,resizable:false,minimizable:false,skipTaskbar:true,hasShadow:false,title:'Friloverse Skins'}));
  overlay.webContents.setBackgroundThrottling(false);
  outsideClicks=new OutsideClickWatcher({down:tracker.mouseDown,point:()=>screen.getCursorScreenPoint(),onOutside:target=>{
    if(target===dashboard&&state.partyDocked){restoreDashboard();place();emitState();}
    else if(target===overlay&&state.mode==='open'){state.mode='tab';place();emitState();}
  }});
  overlay.setAlwaysOnTop(true,'floating');
  launcher=new BrowserWindow(windowOptions({width:72,height:72,frame:false,transparent:true,backgroundColor:'#00000000',show:false,resizable:false,minimizable:false,maximizable:false,skipTaskbar:true,hasShadow:false,focusable:false,title:'Open Friloverse'}));
  launcher.setAlwaysOnTop(true,'floating');
  launcher.on('close',event=>{if(!closed&&!updating)event.preventDefault();});
  lockWindow(dashboard);lockWindow(overlay);lockWindow(launcher);
  overlay.on('close', event=>{ if(!closed&&!updating){event.preventDefault();state.mode='tab';place();emitState();} });
  dashboard.on('close',event=>{if(!closed&&!preview&&!updating){event.preventDefault();hideDashboard();}});
  dashboard.on('closed',()=>app.quit());
  // Without a taskbar button a minimized window would have nowhere to come back from.
  dashboard.on('minimize',()=>{if(!closed&&!updating)hideDashboard();});
  // will-move fires only for a player's drag: their spot is kept from then on.
  dashboard.on('will-move',()=>{if(!state.partyDocked)dashboardMoved=true;});
  ipcMain.handle('ready',event=>{assertSender(event);return state;});
  const {LeagueIcons}=await import('./league-icons.mjs');
  const leagueIcons=new LeagueIcons();
  protocol.handle('friloverse-icon',async request=>{
    const url=new URL(request.url);
    // A picture inside a custom skin's own archive.
    if(url.hostname==='custom'||url.hostname==='local'){
      const image=(url.hostname==='local'?localDatabase:database).embeddedImage(url.pathname.slice(1));
      return image?new Response(image.bytes,{headers:{'Content-Type':image.type,'Cache-Control':'max-age=86400'}}):new Response('Not found',{status:404});
    }
    // Chroma pictures come from League's own files, so CommunityDragon being down costs nothing.
    const [champion,chroma]=url.pathname.slice(1).split('/');
    const icon=url.hostname==='summoner'?await leagueIcons.read(url.pathname.slice(1)).catch(()=>null)
      :url.hostname==='chroma'?await leagueIcons.chroma(champion,chroma).catch(()=>null):null;
    return icon?new Response(icon.bytes,{headers:{'Content-Type':icon.type,'Cache-Control':'max-age=86400'}}):new Response('Not found',{status:404});
  });
  ipcMain.handle('party-icons',async event=>{
    assertSender(event);
    await import('./ui/party-icons.js');
    const {icons,aliases}=JSON.parse(await fs.readFile(path.join(__dirname,'ui','party-icons.json'),'utf8'));
    const catalogue=await leagueIcons.catalogue().catch(()=>null);
    return {icons:globalThis.FriloversePartyIcons.partyIconsFromLocalCatalogue(catalogue,icons,aliases),aliases};
  });
  ipcMain.handle('action',async(event,action)=>{
    assertSender(event);
    if(action?.kind?.startsWith?.('divine-')&&event.sender!==dashboard.webContents)throw new Error('Open Custom Mods to import a skin.');
    try{return await handleAction(action);}
    catch(error){errorLog.failed(action?.kind,error);throw error;}
  });
  // A friend's skin is found by the hash of its contents: in this PC's own Custom
  // Skins, or the Riot skin list. The relay only ever carries that hash.
  party=new PartyCoordinator({dataDir:app.getPath('userData'),version:app.getVersion(),localPick:champion=>choices.partyPick(champion),
    onConnection:line=>errorLog.note('party',line),
    findSkin:async(champion,sha)=>{
      const found=await choices.findByContents(champion,sha);
      // A friend whose Riot list is newer picked something this PC's list does not have yet.
      if(!found&&Date.now()>=nextListForFriend){nextListForFriend=Date.now()+5*60*1000;void checkRiotSkins();}
      return found;
    },artFor:memberArt,onFiles:files=>engine.setParty(files),
    onChange:value=>{
      state.party=value;
      // Fetched before the player answers the pop-up, so the Update button is quick.
      if(value.updateTo&&value.updateTo!==updateOffered){updateOffered=value.updateTo;appUpdater?.check();}
      emitState();
    },
    // Refused for being on another version: this PC may be the older one. A press of the same button.
    onVersionRefused:()=>appUpdater?.check({manual:true})});
  if(!preview){
    const {GameHold}=await import('./game-hold.mjs');
    const {lastScanStart}=await import('./ltk.mjs');
    const {reconnectGame}=await import('./league-client.mjs');
    // A crash can only leave a game frozen if its guard was killed too. The mark means a
    // running game is never touched at start unless Friloverse really was holding one.
    const holdMark=path.join(app.getPath('userData'),'game-held.txt');
    if(existsSync(holdMark)){
      try{require('./game-control.cjs').releaseStranded();}catch{/* Nothing to release. */}
      await fs.unlink(holdMark).catch(()=>{});
    }
    const holdLog=rotatingLog(path.join(app.getPath('userData'),'hold.log'),path.join(app.getPath('userData'),'hold.old.log'));
    let marked=false;
    hold=new GameHold({engine,party,reconnect:reconnectGame,scanStart:lastScanStart,
      busy:()=>actionBusy||!!state.modsPending,
      onChange:()=>{
        state.holdNote=hold.note;
        // The skin panel closes as League opens. Keep the final warning in the lobby too.
        state.holdWarning=hold.released?hold.note:'';emitState();
        if(hold.frozen!==marked){
          marked=hold.frozen;
          void (marked?fs.writeFile(holdMark,'1'):fs.unlink(holdMark)).catch(()=>{});
          // About 90 ms before League minimizes its client, so nothing is left to flash.
          if(marked){
            syncDraftVisibility();
            placeLauncher();place();
          }
        }
      },
      log:line=>{void holdLog(`${new Date().toISOString()} ${line}\n`);}});
  }
  const locallyIdle=()=>!closed&&!actionBusy&&!state.modsPending&&!state.champion&&!party.busy&&!installingLtk&&engine.idle;
  // A new file is only read when a skin is picked, so adding one is safe outside a
  // match, and an app update may be the fix for something else that is broken.
  const quietNow=async()=>{
    if(!locallyIdle()||!await noGameProcess())return false;
    return clientPhaseQuiet(guideWatcher?.sighting.phase??'')&&locallyIdle()&&await noGameProcess();
  };
  // Friloverse can stay in the tray for weeks, so one check per start is not enough.
  if(!preview){
    riotHourly=setInterval(()=>{void runChecks();},60*60*1000);riotHourly.unref?.();
    riotFiveMinute=setInterval(()=>{if(!catalogue.ready)void checkRiotSkins();},5*60*1000);riotFiveMinute.unref?.();
    await refreshCustomMods();
  }
  if(!preview)await party.load();
  else state.party=party.snapshot();
  await Promise.all([dashboard.loadFile(path.join(__dirname,'ui','dashboard.html')),overlay.loadFile(path.join(__dirname,'ui','overlay.html')),launcher.loadFile(path.join(__dirname,'ui','launcher.html'))]);
  if(!preview){
    // Proactive Windows account, RUNASADMIN, and LTK heavy built-ins preflight checks.
    void (async()=>{
      try{
        const ltkDir=path.join(app.getPath('appData'),'dev.leaguetoolkit.manager');
        const {LAUNCHER}=await import('./ltf-bridge.mjs');
        const account=windowsAccount?await windowsAccount.checkWindowsAccount():{issues:[]};
        const ltkChecks=windowsAccount?await windowsAccount.checkLtkAndLauncherSettings({launcherPath:LAUNCHER}):{issues:[],clearedLauncher:false};
        const heavy=await checkLtkBuiltins(ltkDir);
        if(ltkChecks.clearedLauncher)errorLog.note('compat','automatically removed HKCU RUNASADMIN from ltk_launcher.exe');
        if(!account.issues.length)diagnostics.resolve('WINDOWS_ADMIN_SHELL');
        if(!ltkChecks.issues.some(i=>i.code==='LAUNCHER_ELEVATED'))diagnostics.resolve('LAUNCHER_ELEVATED');
        if(!ltkChecks.issues.some(i=>i.code==='LTK_ELEVATED'))diagnostics.resolve('LTK_ELEVATED');
        if(!heavy)diagnostics.resolve('LTK_HEAVY_BUILTINS');
        for(const item of [...account.issues,...ltkChecks.issues,...(heavy?[heavy]:[])]){
          diagnostics.report(item);errorLog.note('compat',`${item.code}: ${item.detail}`);
        }
        state.issues=diagnostics.snapshot();emitState();
      }catch{}
    })();
    tray=new Tray(trayIcon());tray.setToolTip('Friloverse');tray.on('click',showDashboard);
    tray.setContextMenu(Menu.buildFromTemplate([
      {label:`Friloverse ${state.version||''}`.trim(),enabled:false},
      {type:'separator'},
      {label:'Open Friloverse',click:showDashboard},
      {label:'Open Skins Folder',click:()=>{void handleAction({kind:'open-library-folder',id:'skins'}).catch(()=>{});}},
      {label:'Open Logs Folder',click:()=>{void handleAction({kind:'open-logs'}).catch(()=>{});}},
      {label:'Run Diagnostics',click:()=>{void handleAction({kind:'run-diagnostics'}).catch(()=>{});}},
      {type:'separator'},
      {label:'Restart Friloverse',click:()=>{app.relaunch();app.quit();}},
      {label:'Quit Friloverse',click:()=>app.quit()},
    ]));
    try{configureLogin();}catch(error){state.appUpdateStatus=error.message;}
    if(firstRun)try{tray.displayBalloon({title:'Friloverse is ready',content:'It runs in your system tray and opens by itself in champion select. Skins download in the background.'});}catch{}
    // A clean install starts in the tray; without this it looks like nothing is happening.
    const notice=path.join(app.getPath('userData'),'download-notice');
    if(!existsSync(notice)){
      // Windows shows one balloon at a time: on a first run the welcome already says this.
      if(!resumedFromUpdate&&!firstRun)try{tray.displayBalloon({title:'Friloverse is downloading skins',content:'The Riot skin list, custom skins and mods come from GitHub in the background. Open Friloverse to see how far it is.'});}catch{}
      await fs.writeFile(notice,'1').catch(()=>{});
    }else if(state.riotSkinsError&&!resumedFromUpdate)try{tray.displayBalloon({title:'Friloverse could not reach GitHub',content:state.riotSkinsError});}catch{}
    const installed=app.isPackaged&&existsSync(path.resolve(path.dirname(process.execPath),'..','Update.exe'));
    const marker=path.join(app.getPath('userData'),'resume-in-tray');
    const safeToApply=async()=>{
      // A restart nobody asked for never interrupts someone using the window or a party.
      // Pressing Check for updates asks for it: only a match still waits.
      // An update found by the first check of a start is applied even with the window in use (7.1).
      const allowed=()=>(appUpdater.manual||((appUpdater.atStart||!dashboard.isFocused())&&!party.client.session))&&!customImporting&&!state.divineBusy;
      if(!allowed())return false;
      try{return await quietNow()&&allowed();}catch{return false;}
    };
    appUpdater=new AppUpdater({updater:autoUpdater,installed,version:app.getVersion(),onStatus:message=>{appTask(message,{manual:appUpdater.manual});if(appUpdater.manual){state.appUpdateStatus=message;showCheckResult(message);emitState();}},
      // Updates are silent: only a check the player asked for says anything on screen.
      onProblem:error=>errorLog.failed('app-update',{message:shortProblem(error)}),
      canApply:safeToApply,beforeApply:async()=>{
        // An update the player asked for always opens in front, even if they closed the
        // window while it downloaded. Otherwise an open window comes back where it was,
        // without focus, and a hidden one stays in the tray.
        const open=dashboard.isVisible()&&!dashboard.isMinimized();
        if(appUpdater.manual)await fs.unlink(marker).catch(()=>{});
        else await fs.writeFile(marker,[Date.now(),...(open?dashboard.getPosition():[])].join(' '),'utf8');
        if(!await safeToApply()){await fs.unlink(marker).catch(()=>{});return false;}
        updating=true;
        // Said now: a player who just disappears stays on the others' screens for 30 s.
        if(party?.client?.session)await party.leave().catch(()=>{});
        // The new copy starts while this one is still closing. Holding the lock until then
        // would make it hand over to this copy and quit, and nothing would come back.
        app.releaseSingleInstanceLock();
        return true;
      },cancelApply:async()=>{updating=false;app.requestSingleInstanceLock({preview});await fs.unlink(marker).catch(()=>{});}});
  }
  if(preview||!startup)showDashboard();
  if(resumeAt&&!preview){dashboard.setPosition(...resumeAt,false);dashboard.showInactive();dashboard.setSkipTaskbar(true);emitState();syncOutsideClicks();}
  if(showWhenReady){showWhenReady=false;if(dashboard&&!dashboard.isDestroyed())showDashboard();}
  if(preview) {
    // The first card carries the chromas the checks below use: a Riot skin, or (10.6, Riot skins off) the custom one.
    const off=!!state.riotSkinsOff,chroma=(id,name)=>({id,name,image:'artwork/bellion.webp',fallback:'',enabled:false});
    const custom={id:'preview',kind:'custom',name:'Bellion Aatrox',author:'ikiryou',enabled:false,broken:false,image:'artwork/bellion.webp',preview:true,
      ...(off?{chromas:[chroma('preview:ruby','Ruby'),chroma('preview:sapphire','Sapphire')]}:{})};
    state={...state,champion:'Aatrox',mode:'open',connection:'Preview — no connection to League',connected:false,
      skins:[...(off?[]:[{id:'riot:266001',kind:'riot',name:'Justicar Aatrox',author:'',enabled:false,broken:false,image:'artwork/bellion.webp',fallback:'',chromas:[chroma('riot:266099','Ruby'),chroma('riot:266098','Sapphire')]}]),
        custom,
        {id:'local:preview',kind:'custom',source:'local',name:'My Own Aatrox',author:'',enabled:false,broken:false,image:'',preview:true}],
      mods:[{id:'preview-mod',name:'Minecraft Minions',author:'Frog',enabled:false},{id:'preview-emote',name:'Frilo NICE Emote',author:'Frilo',enabled:true}],preview:true};
    place();emitState();
    if(screenshotDir) {
      // Exercise the actual dismiss watcher with deterministic pointer samples;
      // no mouse or keyboard input is sent to the user's desktop.
      const outside=target=>{
        const saved={down:outsideClicks.down,point:outsideClicks.point,now:outsideClicks.now};
        let down=false,now=0;const bounds=target.getBounds();
        outsideClicks.stop();Object.assign(outsideClicks,{down:()=>down,point:()=>({x:bounds.x-5,y:bounds.y}),now:()=>now});
        try{outsideClicks.watch(target);now=1600;down=true;outsideClicks.tick();}
        finally{outsideClicks.stop();Object.assign(outsideClicks,saved);syncOutsideClicks();}
      };
      // Whoever is using this PC meanwhile must not fold the panel under the checks.
      outsideClicks.down=()=>false;
      await fs.mkdir(screenshotDir,{recursive:true});
      await new Promise(r=>setTimeout(r,700));
      await fs.writeFile(path.join(screenshotDir,'panel.png'),(await overlay.webContents.capturePage()).toPNG());
      const tabs=await overlay.webContents.executeJavaScript("[...document.querySelectorAll('.tab')].map(tab=>tab.dataset.tab).join(',')");
      if(state.riotSkinsOff&&tabs.split(',').includes('riot'))throw new Error(`Riot skins are off, yet the panel shows the tabs ${tabs}.`);
      // One click selects; a double click enables, and another disables.
      const clickCard=()=>overlay.webContents.executeJavaScript("document.querySelector('.card').dispatchEvent(new MouseEvent('click',{detail:1,bubbles:true}))");
      await clickCard();await new Promise(r=>setTimeout(r,60));
      if(state.skins[0].enabled||!await overlay.webContents.executeJavaScript("document.querySelector('.card').classList.contains('picked')"))throw new Error('One click must select a skin without enabling it.');
      await new Promise(r=>setTimeout(r,600));
      await clickCard();await new Promise(r=>setTimeout(r,60));
      if(state.skins[0].enabled)throw new Error('Two slow clicks must not enable a skin.');
      await clickCard();await new Promise(r=>setTimeout(r,120));
      if(!state.skins[0].enabled)throw new Error('A double click must enable a skin.');
      await fs.writeFile(path.join(screenshotDir,'panel-enabled.png'),(await overlay.webContents.capturePage()).toPNG());
      await clickCard();await clickCard();await new Promise(r=>setTimeout(r,120));
      if(state.skins[0].enabled)throw new Error('A second double click must disable the skin.');
      // The League icon opens a hidden dashboard, which never gets a taskbar button.
      hideDashboard();
      await launcher.webContents.executeJavaScript("document.getElementById('open').click()");await new Promise(r=>setTimeout(r,200));
      if(!dashboard.isVisible())throw new Error('The League icon did not open Friloverse.');
      const icon=model.launcherBounds({x:40,y:40,width:1600,height:900});
      launcher.setBounds(icon,false);launcher.showInactive();await new Promise(r=>setTimeout(r,300));
      await fs.writeFile(path.join(screenshotDir,'launcher.png'),(await launcher.webContents.capturePage()).toPNG());
      launcher.hide();
      state.skins[0].enabled=true;emitState();await new Promise(r=>setTimeout(r,100));
      if(!await overlay.webContents.executeJavaScript("document.getElementById('disable-skin')?.disabled"))throw new Error('The selected-skin disable control was not shown safely in preview.');
      // Riot and custom skins sit on their own tabs; the wheel opens a skin's chromas.
      state.skins[0].enabled=false;emitState();await new Promise(r=>setTimeout(r,100));
      await overlay.webContents.executeJavaScript("document.querySelector('.wheel').click()");await new Promise(r=>setTimeout(r,60));
      if(await overlay.webContents.executeJavaScript("document.querySelectorAll('.card[data-chroma]').length")!==2)throw new Error('The wheel did not open the chromas.');
      if(state.skins[0].enabled)throw new Error('The wheel must not enable the skin.');
      if(!await overlay.webContents.executeJavaScript("document.getElementById('search').disabled"))throw new Error('The chroma view must not search.');
      await fs.writeFile(path.join(screenshotDir,'panel-chromas.png'),(await overlay.webContents.capturePage()).toPNG());
      const clickChroma=()=>overlay.webContents.executeJavaScript("document.querySelector('.card[data-chroma]').dispatchEvent(new MouseEvent('click',{detail:1,bubbles:true}))");
      await clickChroma();await clickChroma();await new Promise(r=>setTimeout(r,120));
      if(!state.skins[0].chromas[0].enabled||!state.skins[0].enabled)throw new Error('A double click must enable a chroma.');
      await fs.writeFile(path.join(screenshotDir,'panel-chroma-enabled.png'),(await overlay.webContents.capturePage()).toPNG());
      await overlay.webContents.executeJavaScript("document.getElementById('back').click()");await new Promise(r=>setTimeout(r,60));
      await clickCard();await clickCard();await new Promise(r=>setTimeout(r,120));
      if(state.skins[0].enabled||state.skins[0].chromas[0].enabled)throw new Error('A double click on its card must turn the chroma off.');
      state.skins[0].enabled=true;emitState();await new Promise(r=>setTimeout(r,100));
      await overlay.webContents.executeJavaScript("document.querySelector('.tab[data-tab=custom]').click()");await new Promise(r=>setTimeout(r,60));
      if(!await overlay.webContents.executeJavaScript("document.querySelector('.card .label').textContent==='Bellion Aatrox'"))throw new Error('The custom tab did not show custom skins.');
      await fs.writeFile(path.join(screenshotDir,'panel-custom.png'),(await overlay.webContents.capturePage()).toPNG());
      // Local Skins (10.0) have their own tab, apart from the collection's custom skins.
      await overlay.webContents.executeJavaScript("document.querySelector('.tab[data-tab=local]').click()");await new Promise(r=>setTimeout(r,60));
      if(!await overlay.webContents.executeJavaScript("document.querySelectorAll('.card').length===1&&document.querySelector('.card .label').textContent==='My Own Aatrox'"))throw new Error('The local tab did not show only local skins.');
      await fs.writeFile(path.join(screenshotDir,'panel-local.png'),(await overlay.webContents.capturePage()).toPNG());
      await overlay.webContents.executeJavaScript("document.querySelector('.tab').click()");await new Promise(r=>setTimeout(r,60));
      // Leaving a running match opens the same panel, and says what to do next.
      // First a wait while the skin loads, then a loud safe-to-reconnect.
      state.reconnect=true;state.reconnectSafe=false;state.holdNote=(await import('./game-hold.mjs')).RECONNECT_NOTE;state.patcher='applying';emitState();await new Promise(r=>setTimeout(r,120));
      if(!await overlay.webContents.executeJavaScript("(()=>{const b=document.getElementById('reconnect-banner');return !b.hidden&&b.classList.contains('wait')&&b.textContent.includes('DON\\u2019T RECONNECT YET')&&document.getElementById('selection-note').hidden;})()"))throw new Error('The reconnect panel did not say to wait.');
      await fs.writeFile(path.join(screenshotDir,'panel-reconnect-wait.png'),(await overlay.webContents.capturePage()).toPNG());
      state.reconnectSafe=true;state.patcher='ready';emitState();await new Promise(r=>setTimeout(r,120));
      if(!await overlay.webContents.executeJavaScript("(()=>{const b=document.getElementById('reconnect-banner');return b.classList.contains('safe')&&b.textContent.includes('SAFE TO RECONNECT')&&b.textContent.includes('Press Reconnect in League now');})()"))throw new Error('The reconnect panel did not say it is safe.');
      await fs.writeFile(path.join(screenshotDir,'panel-reconnect.png'),(await overlay.webContents.capturePage()).toPNG());
      state.reconnect=false;state.reconnectSafe=null;state.holdNote='';state.patcher='idle';emitState();await new Promise(r=>setTimeout(r,60));
      if(!await overlay.webContents.executeJavaScript("document.getElementById('reconnect-banner').hidden"))throw new Error('The reconnect banner stayed after the game came back.');
      await checkPartyIcons(screenshotDir);
      state.skins[0].enabled=false;emitState();await new Promise(r=>setTimeout(r,100));
      await overlay.webContents.executeJavaScript("document.getElementById('search').dataset.preserved='yes'");
      state.appUpdateStatus='Preview update check';emitState();await new Promise(r=>setTimeout(r,100));
      if(await overlay.webContents.executeJavaScript("document.getElementById('search').dataset.preserved")!=='yes')throw new Error('Unrelated updates replaced the skin search.');
      state.appUpdateStatus='';emitState();
      state.champion='Wukong';emitState();await new Promise(r=>setTimeout(r,100));
      if(!await overlay.webContents.executeJavaScript("document.querySelector('.portrait').getAttribute('src').endsWith('/MonkeyKing.png')"))throw new Error('Champion aliases did not resolve their portrait.');
      state.champion='Aatrox';emitState();await new Promise(r=>setTimeout(r,100));
      outside(overlay);
      if(state.mode!=='tab')throw new Error('Clicking outside did not fold the skin panel.');
      state.error='Preview skin error';emitState();await new Promise(r=>setTimeout(r,100));
      if(!await overlay.webContents.executeJavaScript("document.getElementById('expand').classList.contains('failed')"))throw new Error('A folded skin error was not indicated.');
      state.error='';emitState();await new Promise(r=>setTimeout(r,100));
      await overlay.webContents.executeJavaScript("document.getElementById('expand').click()");
      await new Promise(r=>setTimeout(r,100));
      await overlay.webContents.executeJavaScript("document.getElementById('fold').click()");
      await new Promise(r=>setTimeout(r,300));
      if(state.mode!=='tab')throw new Error('Fold button did not collapse the overlay.');
      if(await overlay.webContents.executeJavaScript("document.querySelector('.party-tab').disabled"))throw new Error('Party button must be available.');
      await fs.writeFile(path.join(screenshotDir,'buttons.png'),(await overlay.webContents.capturePage()).toPNG());
      await fs.writeFile(path.join(screenshotDir,'lobby.png'),(await dashboard.webContents.capturePage()).toPNG());
      dashboard.maximize();await new Promise(r=>setTimeout(r,400));
      if(dashboard.isMaximized()||dashboard.isMaximizable())throw new Error('The lobby window can be maximized.');
      // The top-left panel: a download with its speed and time left, and a task with no known end.
      state.tasks=[{key:'collection',label:'Downloading custom skins & mods',unit:'bytes',value:412*1024**2,max:1.6*1024**3,rate:3.4*1024**2,eta:381,detail:'24 of 93 files'},
        {key:'riot',label:'Checking the Riot skin list',indeterminate:true}];emitState();await new Promise(r=>setTimeout(r,500));
      const cards=await dashboard.webContents.executeJavaScript("[...document.querySelectorAll('#tasks .task')].map(card=>card.querySelector('.task-percent').textContent+'|'+card.querySelector('.task-detail').textContent)");
      if(cards.length!==2||cards[0]!=='25%|412 MB of 1.60 GB · 3.4 MB/s · about 6 min left · 24 of 93 files')throw new Error(`The task panel shows ${JSON.stringify(cards)}.`);
      await fs.writeFile(path.join(screenshotDir,'lobby-tasks.png'),(await dashboard.webContents.capturePage()).toPNG());
      state.tasks=[];emitState();await new Promise(r=>setTimeout(r,100));
      if(!await dashboard.webContents.executeJavaScript("document.getElementById('tasks').hidden"))throw new Error('The task panel stayed with nothing in flight.');
      // A download's bar and numbers move as the bytes arrive (6.3: an update's bar stayed at 0 until it was done).
      const seen=[];
      for(const part of [0,.2,.5,.8]){
        setTask('app',{label:'Downloading the Friloverse update',unit:'bytes',value:Math.round(part*146*1024**2),max:146*1024**2});
        await new Promise(r=>setTimeout(r,450));
        seen.push(await dashboard.webContents.executeJavaScript("(c=>c?[parseFloat(c.querySelector('.task-fill').style.width)||0,c.querySelector('.task-percent').textContent]:[-1,''])(document.querySelector('#tasks .task[data-key=app]'))"));
      }
      // Once every byte is in, the card says what happens next with a moving bar (6.7).
      setTask('app',{label:'Downloading the Friloverse update',unit:'bytes',value:1.5*1024**2,max:1.5*1024**2,
        then:'Installing the Friloverse update',thenDetail:'Putting the new version in place'});
      await new Promise(r=>setTimeout(r,450));
      const after=await dashboard.webContents.executeJavaScript("(c=>c&&[c.classList.contains('moving'),c.querySelector('.task-label').textContent,c.querySelector('.task-percent').textContent,c.querySelector('.task-detail').textContent])(document.querySelector('#tasks .task[data-key=app]'))");
      if(JSON.stringify(after)!==JSON.stringify([true,'Installing the Friloverse update','','Putting the new version in place']))throw new Error(`A finished download shows ${JSON.stringify(after)}.`);
      setTask('app',null);
      if(seen[0][1]!=='0%'||!(seen[1][0]>=19&&seen[2][0]>seen[1][0]&&seen[3][0]>=79&&seen[3][1]==='80%'))throw new Error(`A download's bar did not move: ${JSON.stringify(seen)}.`);
      state.logsStatus='Sent. Your report code is K7M2: tell it to whoever is helping you.';state.logsCode='K7M2';emitState();
      const chosen=await dashboard.webContents.executeJavaScript("(()=>{const icon=document.querySelector('[data-quick-icon]');const id=icon.dataset.quickIcon;icon.click();return id;})()");
      await new Promise(r=>setTimeout(r,100));
      if(state.party.profile.recentIcons?.[0]!==chosen)throw new Error('Party icon history did not update.');
      await dashboard.webContents.executeJavaScript("document.getElementById('open-settings').click()");
      if(!await dashboard.webContents.executeJavaScript("document.getElementById('settings-dialog').open"))throw new Error('Settings did not open.');
      if(!await dashboard.webContents.executeJavaScript("!!document.getElementById('open-skins-folder')"))throw new Error('The skin folder control is missing.');
      if(!await dashboard.webContents.executeJavaScript("(document.getElementById('open-local-skins')?.parentElement?.textContent||'').includes('.modpkg')"))throw new Error('The Local Skins control is missing.');
      await new Promise(r=>setTimeout(r,150));
      if(!await dashboard.webContents.executeJavaScript("document.getElementById('logs-status').classList.contains('sent')&&!!document.getElementById('send-logs')"))throw new Error('Send logs does not show its report code.');
      // Copy Code puts the code on the clipboard and says Copied (6.2); the clipboard is put back.
      const copyLabel=()=>dashboard.webContents.executeJavaScript("(b=>b.hidden?'hidden':b.textContent)(document.getElementById('copy-logs-code'))");
      if(await copyLabel()!=='Copy Code')throw new Error(`Copy Code shows ${await copyLabel()}.`);
      const clipboardBefore=clipboard.readText();
      await dashboard.webContents.executeJavaScript("document.getElementById('copy-logs-code').click()");
      await new Promise(r=>setTimeout(r,150));
      const copied=clipboard.readText();
      if(typeof clipboardBefore==='string'&&clipboardBefore)clipboard.writeText(clipboardBefore);else clipboard.clear();
      // A sandboxed run cannot read the clipboard (readText gives an object): then only the label is checked.
      if(typeof copied!=='string')console.log('The clipboard cannot be read here; Copy Code was checked by its label only.');
      if((typeof copied==='string'&&copied!=='K7M2')||await copyLabel()!=='Copied')throw new Error(`Copy Code copied ${JSON.stringify(copied)} and shows ${await copyLabel()}.`);
      await fs.writeFile(path.join(screenshotDir,'settings.png'),(await dashboard.webContents.capturePage()).toPNG());
      state.logsStatus='';state.logsCode='';emitState();
      await dashboard.webContents.executeJavaScript("document.getElementById('guide-key').click()");
      await new Promise(r=>setTimeout(r,100));
      await dashboard.webContents.executeJavaScript("window.dispatchEvent(new KeyboardEvent('keydown',{key:'g',code:'KeyG',ctrlKey:true,bubbles:true}))");
      await new Promise(r=>setTimeout(r,150));
      if(state.settings.guideHotkey!=='Ctrl+KeyG')throw new Error('Build guide shortcut was not saved.');
      await dashboard.webContents.executeJavaScript("document.getElementById('guide-reset').click()");
      await new Promise(r=>setTimeout(r,150));
      if(state.settings.guideHotkey!=='F1')throw new Error('Build guide shortcut did not reset.');
      // A click inside Settings keeps it; a click outside it closes it (6.1).
      const clickAt=async(x,y)=>{for(const type of ['mouseDown','mouseUp'])dashboard.webContents.sendInputEvent({type,x,y,button:'left',clickCount:1});await new Promise(r=>setTimeout(r,120));};
      const box=await dashboard.webContents.executeJavaScript("(()=>{const r=document.getElementById('settings-dialog').getBoundingClientRect();return {x:Math.round(r.left+12),y:Math.round(r.top+12)};})()");
      await clickAt(box.x,box.y);
      if(!await dashboard.webContents.executeJavaScript("document.getElementById('settings-dialog').open"))throw new Error('A click inside Settings closed it.');
      await clickAt(4,4);
      if(await dashboard.webContents.executeJavaScript("document.getElementById('settings-dialog').open"))throw new Error('A click outside Settings did not close it.');
      // Check for updates and Check databases close Settings (6.2); both do nothing in the preview.
      for(const id of ['check-updates','check-databases']){
        const closes=await dashboard.webContents.executeJavaScript(`(()=>{const d=document.getElementById('settings-dialog');d.showModal();const b=document.getElementById('${id}');const was=b.disabled;b.disabled=false;b.click();b.disabled=was;return !d.open;})()`);
        if(!closes)throw new Error(`${id} left Settings open.`);
      }
      await dashboard.webContents.executeJavaScript("document.getElementById('open-mods').click()");
      if(!await dashboard.webContents.executeJavaScript("document.getElementById('mods-dialog').open"))throw new Error('Custom Mods did not open.');
      if(!await dashboard.webContents.executeJavaScript("!!document.getElementById('refresh-mods')&&!!document.getElementById('open-mods-folder')"))throw new Error('Custom Mods library controls are missing.');
      if(!await dashboard.webContents.executeJavaScript("document.querySelector('#mods-dialog #divine-browse').checkVisibility()"))throw new Error('Divine Skins import is missing from Custom Mods.');
      await new Promise(r=>setTimeout(r,100));
      await fs.writeFile(path.join(screenshotDir,'mods.png'),(await dashboard.webContents.capturePage()).toPNG());
      await dashboard.webContents.executeJavaScript("document.getElementById('close-mods').click()");
      // Themes (6.4): the picker opens, a card puts its theme behind the lobby and saves it, and the
      // lobby's own sky comes back with Friloverse.
      await dashboard.webContents.executeJavaScript("document.getElementById('open-themes').click()");
      if(!await dashboard.webContents.executeJavaScript("document.getElementById('themes-dialog').open&&document.querySelectorAll('#theme-grid .theme-card').length===9"))throw new Error('Themes did not open with its nine themes.');
      await new Promise(r=>setTimeout(r,400));
      await fs.writeFile(path.join(screenshotDir,'themes.png'),(await dashboard.webContents.capturePage()).toPNG());
      for(const theme of ['green-nebula','ichigo','spirit-blossom-ahri','friloverse']){
        await dashboard.webContents.executeJavaScript(`document.querySelector('.theme-card[data-theme="${theme}"]').click()`);
        await new Promise(r=>setTimeout(r,500));
        // The sky or theme shows blurred through the panels.
        const shown=await dashboard.webContents.executeJavaScript(`(()=>{const card=document.querySelector('.theme-card[data-theme="${theme}"]');const blur=getComputedStyle(document.querySelector('.profile-panel')).backdropFilter.includes('blur');return card.getAttribute('aria-checked')==='true'&&document.body.classList.contains('themed')===${theme!=='friloverse'}&&blur;})()`);
        if(!shown||state.settings.theme!==theme)throw new Error(`The ${theme} theme was not applied or saved.`);
        if(theme==='friloverse')break;
        await dashboard.webContents.executeJavaScript("document.getElementById('themes-dialog').close()");
        await new Promise(r=>setTimeout(r,300));
        await fs.writeFile(path.join(screenshotDir,`lobby-theme-${theme}.png`),(await dashboard.webContents.capturePage()).toPNG());
        await dashboard.webContents.executeJavaScript("document.getElementById('open-themes').click()");
      }
      await dashboard.webContents.executeJavaScript("document.getElementById('close-themes').click()");
      const dashboardWasVisible=dashboard.isVisible();
      // Opening Party hides the overlay, so its renderer cannot be used as a
      // completion signal. The resulting state below is the acknowledgement.
      void overlay.webContents.executeJavaScript("document.getElementById('open-party').click()").catch(()=>{});
      await new Promise(r=>setTimeout(r,100));
      if(!state.partyDocked)throw new Error('Party button did not open the dashboard.');
      if(dashboard.isAlwaysOnTop())throw new Error('Party must not remain above other applications.');
      outside(dashboard);
      if(state.partyDocked)throw new Error('Clicking outside did not close the docked Party view.');
      if(dashboard.isVisible()!==dashboardWasVisible)throw new Error('Party did not restore the dashboard visibility.');
      void overlay.webContents.executeJavaScript("document.getElementById('open-party').click()").catch(()=>{});
      await new Promise(r=>setTimeout(r,100));
      if(!state.partyDocked)throw new Error('Party did not reopen.');
      await dashboard.webContents.executeJavaScript("document.getElementById('close-docked').click()");
      await new Promise(r=>setTimeout(r,100));
      if(state.partyDocked)throw new Error('Party dashboard did not close.');
      if(dashboard.isVisible()!==dashboardWasVisible)throw new Error('Party did not restore the dashboard visibility.');
      if(!dashboard.isVisible())showDashboard();
      await dashboard.webContents.executeJavaScript("document.getElementById('name').value='';document.getElementById('create').click()");
      await new Promise(r=>setTimeout(r,100));
      if(!await dashboard.webContents.executeJavaScript("document.getElementById('party-message').textContent.includes('Enter your name')"))throw new Error('Party validation was not shown.');
      state.connection='Preview — waiting for a party';emitState();
      await new Promise(r=>setTimeout(r,100));
      if(!await dashboard.webContents.executeJavaScript("document.getElementById('party-message').textContent.includes('Enter your name')"))throw new Error('Party validation vanished during a state update.');
      await dashboard.webContents.executeJavaScript("document.getElementById('name').value='FrYiLo';document.getElementById('create').click()");
      await new Promise(r=>setTimeout(r,250));
      if(state.party.status!=='connected')throw new Error('Preview room did not open.');
      await dashboard.webContents.executeJavaScript("document.querySelector('.member').dataset.preserved='yes'");
      state.appUpdateStatus='Preview update check';emitState();await new Promise(r=>setTimeout(r,100));
      if(await dashboard.webContents.executeJavaScript("document.querySelector('.member').dataset.preserved")!=='yes')throw new Error('Unrelated updates replaced party members.');
      state.appUpdateStatus='';emitState();
      state.party.members[0].playing='wukong';emitState();await new Promise(r=>setTimeout(r,100));
      if(await dashboard.webContents.executeJavaScript("document.querySelector('.member-skin').textContent")!=='Wukong')throw new Error('Party champion aliases were not displayed.');
      state.party.members[0].playing='aatrox';emitState();await new Promise(r=>setTimeout(r,100));
      await fs.writeFile(path.join(screenshotDir,'room.png'),(await dashboard.webContents.capturePage()).toPNG());
      await checkHostControls(screenshotDir);
      await dashboard.webContents.executeJavaScript("document.getElementById('leave').click()");
      await overlay.webContents.executeJavaScript("document.getElementById('expand').click()");
      await new Promise(r=>setTimeout(r,100));
      if(state.mode!=='open')throw new Error('Skins button did not reopen the overlay.');
      void overlay.webContents.executeJavaScript("document.getElementById('open-party-panel').click()").catch(()=>{});
      await new Promise(r=>setTimeout(r,100));
      if(!state.partyDocked||state.mode!=='tab')throw new Error('Party on the open panel did not open the lobby.');
      await dashboard.webContents.executeJavaScript("document.getElementById('close-docked').click()");
      await new Promise(r=>setTimeout(r,100));
      console.log('Overlay rendering, fold, available Party and reopen checks passed.');
      app.quit();return;
    }
  } else {
    // Running before anything below can hold it up: the skin panel comes from this.
    timer=setInterval(tick,300);
    // Friloverse used to run Celestial, which must not overlay a game alongside LTK Manager.
    if(await noGameProcess()){
      const {retireCelestial}=await import('./ltk-install.mjs');
      const {processRunning}=await import('./process-list.mjs');
      await retireCelestial({running:()=>processRunning('celestial.exe')}).catch(()=>{});
    }
    void poll();
    setTimeout(()=>{appUpdater.atStart=true;void runChecks();},FIRST_CHECK_AFTER).unref?.();
  }
  if(!timer)timer=setInterval(tick,300);
}

function tick(){
  place();placeLauncher();
  if(!preview){
    void poll();
  }
  if(appUpdater?.ready&&Date.now()>=nextUpdateAttempt){nextUpdateAttempt=Date.now()+5000;void appUpdater.applyWhenSafe();}
}

/**
 * Always in this order (7.1): the app's own update, and only when that is settled the databases.
 * An update that restarts Friloverse leaves the databases to the new copy.
 */
function runChecks({manual=false}={}){
  if(preview)return null;
  if(checksRunning){if(manual)appUpdater.check({manual:true});return checksRunning;}
  checksRunning=(async()=>{
    try{
      const answer=await appUpdater.checkAndWait({manual});
      // An update that can go in now gets the moment to do so.
      if(answer==='downloaded')for(let tries=0;tries<40&&!updating&&!closed&&appUpdater.ready;tries++)await new Promise(done=>setTimeout(done,500));
      if(closed||updating)return;
      await Promise.allSettled([checkRiotSkins(),customImportDone.then(()=>syncCustomCollection())]);
    }catch(error){errorLog.failed('checks',error);}
    finally{checksRunning=null;appUpdater.atStart=false;}
  })();
  return checksRunning;
}



async function checkRiotSkins(){
  if(preview)return null;
  // Riot skins are off (riot-skin-availability.mjs): no list check or downloads, nothing on the
  // dashboard about them. The collection clean-up this check also started still runs.
  if(riot.RIOT_SKINS_OFF){void removeWithdrawn();return {downloaded:0,missing:0,left:0};}
  if(riotChecking)return riotChecking;
  riotChecking=runRiotCheck().finally(()=>{riotChecking=false;});
  return riotChecking;
}

async function runRiotCheck(){
  state.riotUpdateStatus='Checking the Riot skin list…';
  setTask('riot',{label:'Checking the Riot skin list',indeterminate:true});
  emitState();
  try{
    // GitHub's list is the source; the local copy is used when it cannot be reached.
    await catalogue.load().catch(()=>false);
    void removeWithdrawn();
    const update=await catalogue.checkRemote();
    if(update.changed){riotCardsHeld.clear();party?.invalidateCache?.();}
    // The forms' files are the only ones this PC keeps; whatever is missing or wrong comes back.
    if(catalogue.ready&&!catalogue.remoteError){
      const compared=await catalogue.audit();
      if(compared.queued)errorLog.note('library',`${compared.queued} Riot form file(s) missing or different from the list`);
    }
    const namesChanged=catalogue.ready&&await catalogue.refreshNames().catch(()=>false);
    // Cards hold the row objects; a name learned after they were built must rebuild them.
    if(namesChanged)riotCardsHeld.clear();
    state.riotSkinsError=catalogue.ready?'':(catalogue.remoteError||catalogue.lastError||'The Riot skin list could not be read. Friloverse tries again later.');
    state.riotUpdateStatus='';
    if(catalogue.ready&&state.champion){
      const row=state.champions.find(item=>model.championKey(item.name)===model.championKey(state.champion));
      // A disk/permission failure in Custom Skins is not a GitHub failure.
      if(row)try{await refreshSkins(row);}catch(error){state.databaseError=`Custom skins database: ${error.message}`;}
    }
  }catch{state.riotSkinsError=catalogue.remoteError||catalogue.lastError||'The Riot skin list could not be read.';state.riotUpdateStatus='';}
  finally{setTask('riot',null);emitState();}
  // A clean PC may start before its network is ready. Retry sooner than the hourly check.
  if(catalogue.ready)riotRetry.cancel();else riotRetry.set(30000);
  const files=await fetchRiotChanges();
  await removeUnusedRiotFiles();
  return files;
}

/** Files earlier versions downloaded and nothing reads; a match stops it and the next check carries on. */
async function removeUnusedRiotFiles(){
  try{
    const {removed}=await catalogue.removeUnused({canContinue:async()=>!closed&&!updating&&!state.champion&&await noGameProcess()});
    if(removed)errorLog.note('library',`removed ${removed} Riot skin file(s) nothing uses any more`);
  }catch(error){errorLog.failed('riot-files',error);}
}

/**
 * The forms' files `audit` found missing or different. Runs after the list check rather than
 * inside it. Never during a match or a game; an unfinished run carries on 5 minutes later.
 */
async function fetchRiotChanges(){
  if(preview||closed)return null;
  if(riotFetching)return riotFetching;
  if(!catalogue.waiting.size)return {downloaded:0,missing:0,left:0};
  riotFetching=runRiotFetch().finally(()=>{riotFetching=false;});
  return riotFetching;
}

async function runRiotFetch(){
  clearTimeout(riotFetchRetry);riotFetchRetry=null;
  let again=false,result=null;
  try{
    result=await catalogue.fetchChanged({canContinue:async()=>!closed&&!updating&&!state.champion&&await noGameProcess()});
    again=result.left>0;
    if(result.downloaded){
      errorLog.note('library',`downloaded ${result.downloaded} Riot form file(s)`);
      state.skinUpdateStatus=`Downloaded ${result.downloaded} Riot skin file${result.downloaded===1?'':'s'}.`;
    }
    if(result.missing)errorLog.note('library',`${result.missing} Riot form file(s) are not on GitHub`);
    // Said once per reason: this is tried again every 5 minutes.
    const leftWhy=result.left?(result.limited?'GitHub is limiting requests':result.stopped?'a match or game is on':'some could not be downloaded'):'';
    if(leftWhy&&leftWhy!==lastRiotLeftNote)errorLog.note('library',`${result.left} Riot form file(s) left for later: ${leftWhy}`);
    lastRiotLeftNote=leftWhy;
  }catch(error){again=true;result={downloaded:0,missing:0,left:catalogue.waiting.size,error};errorLog.failed('riot-files',error);}
  finally{
    setTask('riotFiles',null);emitState();
    if(again&&!closed){riotFetchRetry=setTimeout(()=>{void fetchRiotChanges();},5*60*1000);riotFetchRetry.unref?.();}
  }
  return result;
}

/**
 * A skin taken off GitHub goes from this PC too, at the next check or the first start after an
 * update. Never during a match, where it may be in use; the next check gets it.
 */
async function removeWithdrawn(){
  if(preview||removingWithdrawn||customImporting||state.champion)return;
  removingWithdrawn=true;
  try{
    const {pruneWithdrawn,withdrawnSkins}=await import('./withdrawn-skins.mjs');
    const removed=await pruneWithdrawn({roots:[database.root,modDatabase.root],rows:await withdrawnSkins(),
      remove:file=>shell.trashItem(file).catch(()=>fs.unlink(file))});
    if(!removed.length)return;
    customCards=null;party?.invalidateCache?.();
    for(const file of removed)errorLog.note('library',`removed ${path.basename(file)}: taken off the collection`);
    state.skinUpdateStatus=`Removed ${removed.length===1?'a custom skin':`${removed.length} custom skins`} that no longer ${removed.length===1?'works':'work'}.`;
    await refreshCustomMods();
  }catch(error){errorLog.failed('withdrawn-skins',error);}
  finally{removingWithdrawn=false;}
}

/**
 * The custom skins and mods on GitHub (src/custom-collection.mjs): all of them on a new PC,
 * and each one added later at the next check. Never during a match or a game; the top-left
 * strip shows what it is doing, and an unfinished run carries on 5 minutes later.
 */
async function syncCustomCollection({restore=false}={}){
  if(preview||closed)return null;
  // A press while an automatic check runs is not lost: it runs right after.
  if(collectionSyncing||customImporting){if(restore)collectionRestoreQueued=true;return null;}
  if(!restore&&rateLimitGuard&&!rateLimitGuard.allowed()){
    const wait=rateLimitGuard.remainingMs()+5000;
    collectionRetry=setTimeout(()=>{void syncCustomCollection();},wait);collectionRetry.unref?.();
    return null;
  }
  collectionSyncing=true;
  clearTimeout(collectionRetry);collectionRetry=null;
  let complete=false,added=[],updated=[],outcome=null;
  try{
    const {syncCollection,saveArtwork}=await import('./custom-collection.mjs');
    const {withdrawnSkins}=await import('./withdrawn-skins.mjs');
    const result=await syncCollection({skinsRoot:database.root,modsRoot:modDatabase.root,databaseRoot:path.dirname(database.root),
      withdrawn:await withdrawnSkins(),restore,
      canContinue:async()=>!closed&&!updating&&!state.champion&&await noGameProcess(),
      onArtwork:async artwork=>{database.setArtwork(await saveArtwork(path.dirname(database.root),artwork));localDatabase.setArtwork(database.artwork);customCards=null;},
      onStatus:status=>{
        if(status.phase==='checking')setTask('collection',{label:'Checking custom skins on GitHub',value:status.step||0,max:status.steps||0,
          indeterminate:!status.steps,detail:status.steps?`${status.step||0} of ${status.steps} lists read`:''});
        else setTask('collection',{label:'Downloading custom skins & mods',unit:'bytes',value:status.bytes,max:status.total,indeterminate:!status.total,
          detail:`${status.files} of ${status.count} files`,then:'Checking the downloaded skins',thenDetail:'Each file is checked, then added'});
      }});
    ({complete,added,updated}=result);outcome=result;
    for(const item of result.failed)errorLog.note('library',`could not download ${item.file}: ${item.problem}`);
    for(const item of result.skipped)errorLog.note('library',`left out ${item.file}: ${item.problem}`);
    for(const item of updated)errorLog.note('library',`updated ${item.repositoryPath}: GitHub has a newer version`);
    const says=(verb,list)=>{
      const skins=list.filter(file=>file.kind==='skins').length,mods=list.length-skins;
      return list.length?`${verb} ${[skins&&`${skins} custom skin${skins===1?'':'s'}`,mods&&`${mods} mod${mods===1?'':'s'}`].filter(Boolean).join(' and ')}`:'';
    };
    if(added.length)errorLog.note('library',`downloaded ${added.length} custom package(s) from GitHub`);
    if(added.length||updated.length)state.skinUpdateStatus=`${[says('Added',added),says(added.length?'updated':'Updated',updated)].filter(Boolean).join(', ')} from GitHub.`;
  }catch(error){errorLog.failed('custom-collection',error);outcome={error};}
  finally{
    // GitHub refusing this network waits longer each time, and the player can see why.
    const limited=outcome?.limited||(outcome?.error?.limited?outcome.error:null);
    collectionLimitedRuns=limited?collectionLimitedRuns+1:0;
    if(limited){
      void rateLimitGuard?.note(limited.retryAt);
      state.skinUpdateStatus=collectionLimitSaid=`${String(limited.message).replace(/\.$/,'')}. Friloverse tries again later.`;
    }
    else if(collectionLimitSaid&&state.skinUpdateStatus===collectionLimitSaid){state.skinUpdateStatus='';collectionLimitSaid='';}
    collectionSyncing=false;setTask('collection',null);
    if(added.length||updated.length){
      customCards=null;party?.invalidateCache?.();
      await refreshCustomMods().catch(()=>{});
      if(state.champion){const row=state.champions.find(item=>model.championKey(item.name)===model.championKey(state.champion));if(row)await refreshSkins(row).catch(()=>{});}
    }
    emitState();
    if(collectionRestoreQueued&&!closed){collectionRestoreQueued=false;state.databaseChecking=false;void checkDatabases();}
    else if(!complete&&!closed){
      const wait=retryDelay({limitedRuns:collectionLimitedRuns,retryAt:outcome?.limited?.retryAt||outcome?.error?.retryAt||0});
      collectionRetry=setTimeout(()=>{void syncCustomCollection();},wait);collectionRetry.unref?.();
    }
  }
  return outcome;
}

/**
 * Settings' Send logs (src/log-report.mjs): the last 3 games' logs go to the owner's Cloudflare
 * bucket, and the player is given a short code to pass on.
 */
async function sendLogs(note=''){
  if(preview||state.logsSending)return;
  state.logsSending=true;state.logsStatus='Collecting the logs of your last 3 games…';emitState();
  try{
    const {collectReport,zipFiles,sendReport}=await import('./log-report.mjs');
    const room=party?.snapshot?.();
    const summary={version:app.getVersion(),patcher:state.patcher,patcherError:state.patcherError,connection:state.connection,
      ltkFound,leagueConnected:state.leagueConnected,champion:state.champion,lastSkinClick,
      party:room?.code?{code:room.code,status:room.status,members:room.members.length,host:!!room.members.find(member=>member.id===room.selfId)?.host}:null,
      progress:state.progress?.label||null,settings:state.settings};
    const {files}=await collectReport({dataDir:app.getPath('userData'),ltkDir:path.join(app.getPath('appData'),'dev.leaguetoolkit.manager'),summary,note});
    state.logsStatus='Sending the logs…';emitState();
    const code=await sendReport({zip:zipFiles(files),version:app.getVersion(),name:party?.profile?.name||''});
    state.logsStatus=`Sent. Your report code is ${code}: tell it to whoever is helping you.`;state.logsCode=code;
    errorLog.note('logs',`sent report ${code} (${files.length} files)`);
  }catch(error){state.logsStatus=error.message;errorLog.failed('send-logs',error);}
  finally{state.logsSending=false;emitState();}
}

/** Settings' Check databases: the Riot list, and every custom skin and mod missing from this PC. */
async function checkDatabases(){
  if(preview||state.databaseChecking)return;
  state.databaseChecking=true;state.databaseStatus='Checking the databases on GitHub…';emitState();
  try{
    await customImportDone;
    const [riotFiles,custom]=await Promise.all([checkRiotSkins(),syncCustomCollection({restore:true})]);
    // An automatic check was already running: this press runs right after it and reports then.
    if(!custom){state.databaseStatus='Checking the databases on GitHub…';return;}
    const riot=[
      state.riotSkinsError||catalogue.remoteError?'The Riot skin list could not be checked.':'',
      !riotFiles||riotFiles.error?'The Riot skin files could not be checked.':'',
      riotFiles?.missing?`${riotFiles.missing} Riot skin file${riotFiles.missing===1?' is':'s are'} missing from GitHub.`:'',
      riotFiles?.left?`${riotFiles.left} Riot skin file${riotFiles.left===1?'':'s'} left for later.`:'',
    ].filter(Boolean).map(text=>` ${text}`).join(''),got=(custom.added?.length+custom.updated?.length||0)+(riotFiles?.downloaded||0);
    if(custom.error)state.databaseStatus=`The custom skins could not be checked: ${String(custom.error.message||custom.error).replace(/\.$/,'')}.${riot}`;
    else if(custom.stopped)state.databaseStatus=`Added or updated ${got} so far; the rest download after the match.${riot}`;
    else if(custom.limited)state.databaseStatus=`Added or updated ${got}; ${String(custom.limited.message).replace(/\.$/,'')}. The rest are tried again later.${riot}`;
    else if(custom.failed.length)state.databaseStatus=`Added or updated ${got}; ${custom.failed.length} could not be downloaded and are tried again in 5 minutes.${riot}`;
    else if(got)state.databaseStatus=`Databases checked: added or updated ${got} file${got===1?'':'s'}.${riot}`;
    else if(riot)state.databaseStatus=`Database check incomplete.${riot}`;
    else state.databaseStatus=`Databases checked: nothing is missing.${riot}`;
  }finally{
    if(!collectionRestoreQueued){state.databaseChecking=false;showCheckResult(state.databaseStatus);}
    emitState();
  }
}

/** A party member's skin as a picture, found by the hash of its contents. */
async function memberArt(championId,sha){
  const row=state.champions.find(item=>model.championKey(item.id)===championId||model.championKey(item.name)===championId);
  if(!row)return null;
  const number=Number(row.key);
  if(!riot.RIOT_SKINS_OFF){
    const entries=await catalogue.forChampion(number);
    const riotSkin=entries.find(skin=>skin.sha===sha);
    if(riotSkin){
      const id=`riot:${riotSkin.id}`,card=riotCardsFor(row,entries).find(item=>item.id===id||item.chromas?.some(chroma=>chroma.id===id));
      return card?{image:card.image,fallback:card.fallback}:null;
    }
  }
  const local=await database.findArchive(row.name,sha);
  if(!local)return null;
  const image=(await database.list(row.name)).skins.find(skin=>skin.id===local)?.image;
  return image?{image,fallback:''}:null;
}

// The cards are only built again when the catalogue reads a new list of files.
function riotCardsFor(row,entries){
  const number=Number(row.key);
  let held=riotCardsHeld.get(number);
  if(held?.entries!==entries){
    held={entries,cards:riot.riotCards(riotCatalog.get(number)||{id:row.id,key:row.key,name:row.name,skins:[]},entries)};
    riotCardsHeld.set(number,held);
  }
  return held.cards;
}

async function refreshCustomMods({preserveError=false}={}){
  if(preview)return;
  try{
    const result=await customMods.list();
    state.mods=result.mods;if(!preserveError||!result.available){state.modsError=result.available?'':'Custom mods database folder not found.';state.modsNotice='';}
    engine.setMods(await customMods.files());
  }catch(error){state.modsError=error.message;}
  emitState();
}

function assertSender(event) {
  if(![dashboard?.webContents,overlay?.webContents,launcher?.webContents].includes(event.sender) || event.senderFrame!==event.sender.mainFrame) throw new Error('Unknown Friloverse window.');
}

// A champion's skins for the panel: Riot's, then the player's own, with the choice marked.
async function refreshSkins(row,{live=()=>true}={}){
  if(!row)return;
  const wanted=model.championKey(row.name);
  const number=Number(row.key);
  const entries=await catalogue.forChampion(number).catch(()=>[]);
  if(!live()||model.championKey(state.champion)!==wanted)return;
  const cards=riotCardsFor(row,entries);
  // This runs at every poll, and reading a champion's folder at that rate only costs smoothness.
  let custom=customCards;
  if(custom?.champion!==wanted||Date.now()-custom.at>CUSTOM_LIST_AGE)custom=await model.readCustomCards(customAndLocal,row.name,wanted,custom);
  // The champion can change while the folders are being read.
  if(!live()||model.championKey(state.champion)!==wanted)return;
  customCards=custom;
  const picked=choices.pick(row.name)?.id||'';
  state.databaseError=customCards.error?`Custom skins database: ${customCards.error}`:state.riotSkinsError||'';
  state.skins=[...cards,...customCards.skins].map(skin=>markPicked(skin,picked));
}
// The Custom Skins database, then the player's Local Skins. A LocalSkins folder that cannot be
// read costs only its own cards (its problems go to errors.log through onProblem).
async function customAndLocal(name){
  const [custom,local]=await Promise.all([database.list(name),localDatabase.list(name).catch(error=>{errorLog.note('library',`could not read LocalSkins: ${error.message}`);return {skins:[]};})]);
  return {...custom,skins:[...custom.skins,...local.skins]};
}
// Disk/network reads must never stop phase handling or leave the Skins/Party controls blank.
const skinReads=new PollGate();
function refreshSkinsSoon(row){
  const wanted=model.championKey(row.name);
  if(skinReads.current&&skinReads.current.champion!==wanted){skinReads.current.live=false;skinReads.current=null;}
  const run=skinReads.begin();
  if(!run)return;
  run.champion=wanted;
  void refreshSkins(row,{live:()=>run.live&&!closed}).catch(error=>{
    if(run.live&&model.championKey(state.champion)===model.championKey(row.name))state.databaseError=`Custom skins database: ${error.message}`;
  }).finally(()=>{if(skinReads.end(run)&&!closed){place();emitState();}});
}
function markPicked(skin,picked){
  const chromas=skin.chromas?.map(chroma=>({...chroma,enabled:chroma.id===picked}));
  return {...skin,...(chromas?{chromas}:{}),enabled:skin.id===picked||!!chromas?.some(chroma=>chroma.enabled)};
}

// League's client says when its phase or the champion changes (`LeagueEvents`), and the watcher
// has it within moments. The panel, the hold and the engine hear it here, not at the next tick:
// a lock-in opens the panel at once, and the draft's end is not seen a tick or two late.
let seenSighting='',pollWanted=false,pollDraftId=null;
function lookSoon(sighting){
  // Before the first tick nothing is ready to hear it; that tick sees it anyway.
  if(!timer||closed)return;
  const sp=guideWatcher.swiftplay;
  const spMark=sp?.active?`${sp.searching?1:0}:${sp.slots.map(s=>`${s.championId}@${s.skinSlot}`).join(',')}`:'';
  const mark=`${sighting.phase}|${sighting.champion}|${guideWatcher.draftId}|${[...guideWatcher.skinSlots].flat().join(',')}|${spMark}`;
  if(mark===seenSighting)return;
  seenSighting=mark;
  if(polls.current)pollWanted=true;
  else void poll();
}

async function poll() {
  if(closed||preview)return;
  const run=polls.begin();
  if(!run)return;
  try {
    if(!ltkFound&&Date.now()>=nextLtkCheck){
      nextLtkCheck=Date.now()+5000;
      ltkFound=await resolveLtkExecutable().then(()=>true,()=>false);
      if(!run.live)return;
    }else if(ltkFound&&!installingLtk&&ltkPresence.due){
      // Beside the poll, which has to stay quick: this asks the registry four times.
      void ltkPresence.check().then(gone=>{
        if(!gone||closed||installingLtk)return;
        ltkFound=false;nextLtkCheck=0;errorLog.note('ltk','LTK Manager is no longer installed where it was');
      });
    }
    const sighting=guideWatcher.sighting,phase=sighting.phase;
    // What a panel that did not come had to go on.
    if(phase!=='ChampSelect')draftNoted=false;
    else if(!draftNoted){draftNoted=true;errorLog.note('panel',`draft seen: ${state.champions.length} champions, Riot list ${riot.RIOT_SKINS_OFF?'off':catalogue.ready?'ready':'not ready'}`);}
    if(sighting.lostAt&&sighting.lostAt!==notedChampionLoss){notedChampionLoss=sighting.lostAt;errorLog.note('panel',"League's draft lost the champion for a moment; the panel stayed");}
    const spRaw=guideWatcher.swiftplay;
    const swiftplayActive=Boolean(spRaw?.active&&Array.isArray(spRaw.slots)&&spRaw.slots.length>0&&['Lobby','Matchmaking','ReadyCheck'].includes(phase));
    const spSlots=swiftplayActive?spRaw.slots.map((slot,index)=>{
      const found=state.champions.find(item=>Number(item.key)===slot.championId)||null;
      const pick=found?choices.pick(found.name):null;
      return {index,championId:slot.championId,name:found?.name||'',position:slot.position||'',pickedLabel:pick?.label||''};
    }).filter(slot=>slot.name):[];
    const spIndex=spSlots.length?Math.min(Math.max(0,typeof swiftplaySlot!=='undefined'?swiftplaySlot:0),spSlots.length-1):0;
    if(typeof swiftplaySlot!=='undefined')swiftplaySlot=spIndex;
    const row=swiftplayActive&&spSlots[spIndex]
      ?state.champions.find(item=>Number(item.key)===spSlots[spIndex].championId)||null
      :state.champions.find(item=>Number(item.key)===sighting.champion)||null;
    // Only the real Reconnect screen with no game process allows a new choice.
    const gameGone=phase==='Reconnect'&&await noGameProcess();
    if(!run.live)return;
    if(guideWatcher.sighting.phase!==phase){pollWanted=true;return;}
    readTeamSlots();
    if(guideWatcher.matchChampions&&typeof party.setMatchChampions==='function'){
      const matchNames=[];
      for(const cid of guideWatcher.matchChampions){
        const found=state.champions.find(item=>Number(item.key)===cid);
        if(found?.name)matchNames.push(found.name);
      }
      party.setMatchChampions(matchNames.length?matchNames:null);
    }
    hold.observe(phase,{gameGone,draftId:guideWatcher.draftId,swiftplaySearching:swiftplayActive&&!!spRaw.searching});
    engine.setSwiftplay?.(swiftplayActive);
    // A new draft the poll reached without seeing the lobby between (a dodge, a quick requeue):
    // the last draft's pick must not reach the engine beside the new draft's guard (10.5).
    if(phase==='ChampSelect'){
      if(pollDraftId!==null&&guideWatcher.draftId!==pollDraftId){choices.clear();state.restoredSkin=null;if(typeof restoredDraftKey!=='undefined')restoredDraftKey='';}
      pollDraftId=guideWatcher.draftId;
      const left=leagueClient.draftTimeLeft(guideWatcher.draft);
      const imminent=typeof leagueClient.draftLaunchImminent==='function'?leagueClient.draftLaunchImminent(guideWatcher.draft):true;
      hold.setTimeLeft(imminent?left:null);
      engine.setDraftTimeLeft?.(imminent&&Number.isFinite(left)?left:Infinity);
    }else{
      engine.setDraftTimeLeft?.(Infinity);
    }
    if(typeof windowsAccount!=='undefined'&&windowsAccount&&guideWatcher.lastClient?.pid&&guideWatcher.lastClient.pid!==lastLeaguePidChecked){
      lastLeaguePidChecked=guideWatcher.lastClient.pid;
      void windowsAccount.checkLeagueElevation({pid:lastLeaguePidChecked}).then(res=>{
        if(res.ok)diagnostics?.resolve('LEAGUE_ELEVATED');
        else for(const item of res.issues){diagnostics?.report(item);errorLog.note('compat',`${item.code}: ${item.detail}`);}
        if(diagnostics){state.issues=diagnostics.snapshot();emitState();}
      }).catch(()=>{});
    }
    const reconnect=phase==='Reconnect'&&hold.reconnectWindow&&!hold.frozen;
    const reconnectRun=reconnect?hold.guardRun:null;
    const returned=reconnect&&reconnectRun!==state.reconnectRun;
    const status={connected:guideWatcher.connected,phase,reconnect,reconnectRun,swiftplay:swiftplayActive&&spSlots.length>0,championName:row?.name||(reconnect?party.ownChampion:null)||null};
    const view=model.nextView(state,status);
    const arriving=(!!view.champion&&!state.champion)||(view.mode!=='hidden'&&state.mode==='hidden');
    const changed=model.championKey(view.champion)!==model.championKey(state.champion);
    Object.assign(state,view,{reconnect,reconnectRun,swiftplay:swiftplayActive&&spSlots.length?{active:true,searching:!!spRaw.searching,activeSlot:spIndex,slots:spSlots}:null,
      connected:ltkFound,ltkNotice:bridge.notice,leagueConnected:guideWatcher.connected,
      connection:state.ltkInstalling?'Installing LTK Manager…':!ltkFound?'Friloverse needs LTK Manager to load skins.':guideWatcher.connected?`League connected – ${model.phaseLabel(phase)}`:'Waiting for League client'});
    if(arriving&&syncDraftVisibility())clearForDraft();
    if(returned){
      errorLog.note('panel',`Reconnect: opening the skin catalogue for ${view.champion||'the current champion'}`);
      try{tracker.restoreClient();}catch{/* Placement retries when League's window returns. */}
    }
    if(changed){state.error='';state.skins=[];state.restoredSkin=null;}
    const showing=state.champion?state.champions.find(item=>model.championKey(item.name)===model.championKey(state.champion)):null;
    if(showing){
      refreshSkinsSoon(showing);
      // Opt-in Historic Mode: restore the player's last picked skin for this champion once per draft.
      const restoreKey=`${guideWatcher.draftId}:${model.championKey(showing.name)}`;
      if((phase==='ChampSelect'||swiftplayActive)&&state.settings?.rememberLastSkin&&typeof skinHistory!=='undefined'&&skinHistory&&!choices.pick(showing.name)&&!actionBusy&&restoredDraftKey!==restoreKey){
        const prior=skinHistory.get(showing.name);
        if(prior?.id){
          restoredDraftKey=restoreKey;
          state.restoredSkin={id:prior.id,label:prior.label||'Last skin'};
          void handleAction({kind:'select',id:prior.id,fromHistory:true}).catch(()=>{state.restoredSkin=null;});
        }
      }
    }else{
      state.skins=[];state.databaseError='';
      // League can stop naming the champion mid-draft; only the draft's end closes Party.
      if(state.partyDocked&&state.mode==='hidden'&&!(status.connected&&(phase==='ChampSelect'||swiftplayActive)))clearForGame();
    }
    party.observe(state.champion,phase);
    // Every draft starts with skins off, and League can requeue seconds after a game.
    // No phase at all is League's client out of reach for a moment, which is no reason to drop a pick.
    if(phase&&!swiftplayActive&&!['ChampSelect','GameStart','InProgress','Reconnect','WaitingForStats','PreEndOfGame'].includes(phase)){
      choices.clear();state.restoredSkin=null;if(typeof restoredDraftKey!=='undefined')restoredDraftKey='';
      if(typeof emergencyModsOff!=='undefined'&&emergencyModsOff){emergencyModsOff=false;void refreshCustomMods();}
    }
    const personalPick=swiftplayActive&&spSlots.length
      ?spSlots.map(slot=>choices.pick(slot.name)).filter(Boolean)
      :choices.pick(party.ownChampion);
    engine.setPersonal(Array.isArray(personalPick)?(personalPick.length?personalPick:null):personalPick);
    engine.observe(phase);
    party.refreshLocal();
  } catch(e) {
    console.error('Friloverse update failed:',e.message);
  } finally {
    if(polls.end(run)){
      place();emitState();
      // Something changed while this look was under way: it may have read the moment before.
      if(pollWanted){pollWanted=false;setImmediate(()=>{void poll();});}
    }
  }
}

// The watcher carries the current match's League selections from the draft through Reconnect.
let nextListForFriend=0,queuedSkin=null,updateOffered='',removingWithdrawn=false,customCards=null;
const CUSTOM_LIST_AGE=3000;
function readTeamSlots(){
  const named=new Map();
  for(const [number,slot] of guideWatcher.skinSlots){
    const row=riotCatalog.get(number)||state.champions.find(item=>Number(item.key)===number);
    if(row?.id)named.set(String(row.id).toLowerCase(),slot);
  }
  engine.setSlots(named);
}

// The real picker: League's own artwork loads, and a choice leads the recent list.
async function checkPartyIcons(folder){
  const page=dashboard.webContents,run=code=>page.executeJavaScript(code).catch(error=>{throw new Error(`${error.message} (${code.slice(0,120)})`);});
  const wait=ms=>new Promise(done=>setTimeout(done,ms));
  state.party={...state.party,status:'idle',profile:{name:'Frilo',icon:'',recentIcons:[]}};emitState();
  revealDashboard();await wait(300);
  await run("document.getElementById('avatar').click()");await wait(500);
  const shown=await run("document.querySelectorAll('#icon-grid [data-icon]').length");
  if(shown<1500)throw new Error(`The icon picker only listed ${shown} icons.`);
  await fs.writeFile(path.join(folder,'icons-all.png'),(await page.capturePage()).toPNG());
  await run("document.querySelector('[data-icon-category=illustration]').click()");await wait(800);
  await fs.writeFile(path.join(folder,'icons-illustrations.png'),(await page.capturePage()).toPNG());
  const loaded=await run("[...document.querySelectorAll('#icon-grid img')].slice(0,12).filter(image=>image.complete&&image.naturalWidth>0&&image.src.startsWith('friloverse-icon:')).length");
  console.log(`League artwork loaded in the picker: ${loaded} of 12.`);
  await run("document.getElementById('icon-search').value='zzzz';document.getElementById('icon-search').dispatchEvent(new Event('input'))");await wait(400);
  if(!await run("Boolean(document.querySelector('.icon-none'))"))throw new Error('An empty icon search did not say so.');
  await run("document.getElementById('icon-search').value='';document.getElementById('icon-search').dispatchEvent(new Event('input'))");await wait(100);
  const ids=await run("[...document.querySelectorAll('#icon-grid [data-icon]')].slice(0,2).map(button=>button.dataset.icon)");
  for(const id of [ids[0],ids[1],ids[0]]){
    if(!await run("document.getElementById('icon-dialog').open"))await run("document.getElementById('avatar').click()");
    await wait(150);
    await run(`document.querySelector('[data-icon="${id}"]').click()`);await wait(200);
  }
  if(await run("document.querySelectorAll('#quick-icons>*').length")!==6||await run("Boolean(document.getElementById('choose-icon'))"))throw new Error('There should be six recent icon slots and no + button.');
  const quick=await run("[...document.querySelectorAll('#quick-icons [data-quick-icon]')].map(button=>button.dataset.quickIcon)");
  if(quick.join()!==[ids[0],ids[1]].join())throw new Error(`The recent icons were wrong: ${quick.join()}`);
  if(!await run("document.querySelector('#quick-icons button').classList.contains('selected')&&!!document.querySelector('#avatar img')"))throw new Error('The selected icon was not shown.');
  await run("document.querySelector('#quick-icons .empty').click()");await wait(150);
  if(!await run("document.getElementById('icon-dialog').open"))throw new Error('An empty recent slot should open the icon picker.');
  await run("document.getElementById('close-icons').click()");
  // Arena items are only 64 pixels, and must still fill the ring edge to edge.
  await run("document.getElementById('avatar').click()");await wait(150);
  await run(`document.querySelector('[data-icon-category=item]').click();document.querySelector('[data-icon]').click()`);await wait(500);
  const avatarFit=await run("(()=>{const box=document.getElementById('avatar'),ring=box.getBoundingClientRect(),image=box.querySelector('img').getBoundingClientRect();return Math.abs(image.width-ring.width)<1&&Math.abs(image.height-ring.height)<1;})()");
  if(!avatarFit)throw new Error('The party icon does not fill its ring.');
  await fs.writeFile(path.join(folder,'icons-recent.png'),(await page.capturePage()).toPNG());
  // Party opens at 77.5% of a 1280x720 client; 640x360 is the smallest window.
  const size=dashboard.getSize();
  for(const [width,height] of [[992,558],[640,360]]){
    dashboard.setSize(width,height);await wait(250);await run('fitStage()'); // A covered window gets no resize event.
    // Custom Mods, Themes and Settings sit in a row on the capsule, evenly spaced and clear of the heading, at every size.
    const placed=await run("(()=>{const rect=id=>document.getElementById(id).getBoundingClientRect(),mods=rect('open-mods'),themes=rect('open-themes'),gear=rect('open-settings'),logo=document.querySelector('.logo').getBoundingClientRect(),mid=r=>(r.top+r.bottom)/2,gap1=themes.left-mods.left,gap2=gear.left-themes.left;return Math.abs(mid(mods)-mid(gear))<2&&Math.abs(mid(themes)-mid(gear))<2&&gap1>0&&Math.abs(gap1-gap2)<2&&mods.left>logo.right;})()");
    if(!placed)throw new Error(`Custom Mods and Themes are misplaced at ${width} wide.`);
    const fits=await run("(()=>{const stage=document.getElementById('stage').getBoundingClientRect();return stage.left>=-1&&stage.top>=-1&&stage.right<=innerWidth+1&&stage.bottom<=innerHeight+1&&Math.abs(document.getElementById('join').getBoundingClientRect().width/stage.width-468/1672)<.01;})()");
    if(!fits)throw new Error(`The lobby picture does not fit at ${width} wide: ${await run("JSON.stringify([innerWidth,innerHeight,document.getElementById('stage').getBoundingClientRect(),document.getElementById('join').getBoundingClientRect(),document.getElementById('stage').style.cssText])")}`);
    await fs.writeFile(path.join(folder,`lobby-${width}.png`),(await page.capturePage()).toPNG());
    if(width===640){
      await run("document.getElementById('avatar').click()");await wait(300);
      await fs.writeFile(path.join(folder,'icons-640.png'),(await page.capturePage()).toPNG());
      await run("document.getElementById('close-icons').click()");
    }
  }
  dashboard.setSize(...size);await wait(150);
}

// The host's Stealth and Kick on a real room view, with one stand-in friend.
async function checkHostControls(folder){
  const page=dashboard.webContents,run=code=>page.executeJavaScript(code);
  const wait=ms=>new Promise(done=>setTimeout(done,ms));
  state.party={...state.party,selfId:'preview',members:[...state.party.members,{id:'friend',name:'Friend',icon:'',host:false,playing:'ahri',skin:{relative:'Star Guardian Ahri',championId:'ahri'},art:{image:'artwork/bellion.webp'},preparation:'preparing'},
    {id:'two',name:'Sam',icon:'',host:false,playing:'zed',skin:{relative:'Project Zed',championId:'zed'},preparation:'prepared'},{id:'three',name:'Alex',icon:'',host:false,playing:'lux',skin:null,preparation:'selected'},{id:'four',name:'Noa',icon:'',host:false,playing:'jinx',skin:{relative:'Odyssey Jinx',championId:'jinx'},preparation:'error'},{id:'five',name:'Rin',icon:'',host:false,playing:null,skin:null,preparation:'prepared'}]};emitState();await wait(250);
  const friend="document.querySelectorAll('.member')[1]";
  // A champion's own art stands in until a member picks a skin; it comes from outside the app.
  for(let tries=0;tries<30&&!await run("[...document.querySelectorAll('.member-art')].some(image=>image.src.includes('ddragon')&&image.complete)");tries++)await wait(100);
  console.log(`Champion art loaded on the member cards: ${await run("[...document.querySelectorAll('.member-art')].filter(image=>image.src.includes('ddragon')&&image.naturalWidth>0).length")}.`);
  if(!await run(`${friend}.textContent.includes('Star Guardian Ahri')`))throw new Error('A friend\'s pick was not shown.');
  if(await run("document.getElementById('stealth').hidden"))throw new Error('The host has no Stealth button.');
  if(!await run("document.getElementById('stealth-badge').hidden"))throw new Error('The host should not see the guests\' Stealth label.');
  await run("document.getElementById('stealth').click()");await wait(150);
  if(state.party.stealth!==true||!await run("document.getElementById('stealth').classList.contains('active')"))throw new Error('Stealth did not turn on.');
  if(await run(`${friend}.textContent.includes('Ahri')`)||!await run(`${friend}.textContent.includes('Hidden')`))throw new Error('Stealth did not hide the friend\'s pick.');
  await fs.writeFile(path.join(folder,'room-stealth.png'),(await page.capturePage()).toPNG());
  await wait(420);await run("document.getElementById('stealth').click()");await wait(150);
  if(!await run(`${friend}.textContent.includes('Star Guardian Ahri')`))throw new Error('Stealth did not turn off.');
  const button=await run(`(()=>{const rect=${friend}.querySelector('.kick').getBoundingClientRect();return rect.width>=40&&rect.height>=22;})()`);
  if(!button)throw new Error('The Kick button is too small to use.');
  await run(`${friend}.querySelector('.kick').click()`);await wait(100);
  if(state.party.members.length!==6||!await run(`${friend}.querySelector('.kick').textContent==='Confirm?'`))throw new Error('Kick must ask first.');
  await fs.writeFile(path.join(folder,'room-kick.png'),(await page.capturePage()).toPNG());
  await run(`${friend}.querySelector('.kick').click()`);await wait(100);
  if(state.party.members.length!==5)throw new Error('Kick did not remove the player.');
  state.party={...state.party,members:state.party.members.slice(0,1)};emitState();await wait(100);
  // A member on a newer version: the pop-up says which, in the lobby's own look.
  state.party={...state.party,code:'TEST',updateTo:'9.9'};emitState();await wait(150);
  if(!await run("document.getElementById('update-dialog').open&&document.getElementById('update-now').textContent.includes('9.9')"))throw new Error('The update pop-up did not open with the version number.');
  await fs.writeFile(path.join(folder,'update-popup.png'),(await page.capturePage()).toPNG());
  await run("document.getElementById('update-now').click()");await wait(150);
  if(!await run("document.getElementById('update-now').disabled"))throw new Error('Pressing Update did not say it had started.');
  await run("document.getElementById('update-later').click()");await wait(100);
  state.party={...state.party,updateTo:'9.9',members:[...state.party.members]};emitState();await wait(100);
  if(await run("document.getElementById('update-dialog').open"))throw new Error('Later must not bring the pop-up straight back.');
  state.party={...state.party,updateTo:''};emitState();await wait(100);
  // A guest sees that Stealth is on, and cannot change it.
  state.party={...state.party,stealth:true,members:state.party.members.map(member=>({...member,host:false}))};emitState();await wait(100);
  if(!await run("document.getElementById('stealth').hidden&&!document.getElementById('stealth-badge').hidden"))throw new Error('A guest must see Stealth as a label only.');
  state.party={...state.party,stealth:false,members:state.party.members.map(member=>({...member,host:true}))};emitState();await wait(100);
}

// The League corner launcher: in the client outside a match, and in the current champion select.
function launcherAllowed(){
  return model.launcherAllowed({phase:guideWatcher?.sighting.phase||'',draftActive:syncDraftVisibility()});
}
function placeLauncher(){
  if(!launcher||launcher.isDestroyed())return;
  const client=tracker.clientWindow(),active=tracker.foregroundPid();
  const ownWindow=active===process.pid&&(dashboard?.isFocused()||overlay?.isFocused());
  // A game being held: restarting it brings League's client back for about a second.
  if(!client||!launcherAllowed()||(active!==client.pid&&!ownWindow)){if(launcher.isVisible())launcher.hide();return;}
  const bounds=screen.screenToDipRect(null,model.launcherBounds(client)),placed=JSON.stringify(bounds);
  if(placed!==launcherPlaced){launcherPlaced=placed;launcher.setBounds(bounds,false);}
  if(!launcher.isVisible())launcher.showInactive();
  // Windows can move it behind the client even though it asks to stay on top.
  if(Date.now()>=nextLauncherRaise){nextLauncherRaise=Date.now()+1000;launcher.moveTop();}
}

// What the panel did and why, as a player can only say "it was not there" afterwards.
function tracePanel(){
  if(preview||!overlay||overlay.isDestroyed())return;
  const shown=overlay.isVisible()?state.mode:`hidden, ${panelHiddenBy||'not placed yet'}`;
  const seen=state.mode==='hidden'?'':`${state.champion}: ${shown}`;
  if(seen===panelSeen)return;
  panelSeen=seen;
  if(seen)errorLog.note('panel',seen);
}
function place(){placeOverlay();tracePanel();}
// A draft has started: the panel must not open behind Friloverse's own lobby.
function clearForDraft(){
  if(!dashboard||dashboard.isDestroyed())return;
  // Party the player opened earlier in this draft stays; the panel is there when they close it.
  if(state.partyDocked)return;
  const inFront=dashboard.isVisible()&&dashboard.isFocused();
  if(!inFront)return;
  dashboard.hide();
  try{tracker.focusClient();}catch{/* The panel still shows if League is in view. */}
}
// End the draft with every companion window hidden, including a focused lobby or
// one on another monitor. Restore bounds without ever raising a saved dashboard.
function clearForGame(){
  if(dashboard&&!dashboard.isDestroyed()){
    dashboard.hide();
    if(savedDashboard)savedDashboard.visible=false;
    if(state.partyDocked)restoreDashboard({raise:false});
    dashboard.setAlwaysOnTop(false);
  }
  overlay?.hide();launcher?.hide();
  foregroundLeftAt=0;
  syncOutsideClicks();
}
function placeOverlay() {
  if(!overlay || overlay.isDestroyed())return;
  if(!syncDraftVisibility()||state.mode==='hidden'){panelHiddenBy='skin selection is not active';overlay.hide();syncOutsideClicks();return;}
  if(state.partyDocked&&dashboard?.isFocused()){panelHiddenBy='the Party view is open';overlay.hide();syncOutsideClicks();return;}
  let bounds;
  if(preview) {
    const work=screen.getPrimaryDisplay().workArea;
    const width=state.mode==='tab'?468:1076,height=state.mode==='tab'?58:453;
    bounds={x:Math.round(work.x+(work.width-width)/2),y:Math.round(work.y+(work.height-height)/2),width,height};
  } else {
    const client=tracker.clientWindow();
    if(client)lastClient=client;
    const front=tracker.foregroundWindow();
    // Only a window really in front of League hides the panel. League can lose the foreground to
    // nothing, a hidden window or another monitor while the player is still looking at it.
    const elsewhere=!client||!state.leagueConnected||model.clientCovered(client,front,{ownPid:process.pid,overlayFocused:overlay.isFocused()});
    if(!elsewhere&&foregroundLeftAt){errorLog.note('panel',`another program had the foreground for ${Date.now()-foregroundLeftAt} ms; the panel stayed`);foregroundLeftAt=0;}
    if(elsewhere){
      // A program can take the foreground for an instant, as LTK Manager can while it starts.
      // Hiding for that looks like the panel closing and opening again by itself.
      if(client&&state.leagueConnected&&overlay.isVisible()){
        foregroundLeftAt||=Date.now();
        if(Date.now()-foregroundLeftAt<FOREGROUND_GRACE)return;
      }
      panelHiddenBy=!client?'League client window not found':!state.leagueConnected?'League client not connected':`${tracker.processName(front?.pid)||'another program'} is in front of League`;
      foregroundLeftAt=0;overlay.hide();syncOutsideClicks();return;
    }
    const anchor=client;
    if(anchor)bounds=screen.screenToDipRect(null,model.overlayBounds(anchor,state.mode));
    else{
      const work=screen.getPrimaryDisplay().workArea;
      bounds={x:Math.round(work.x+(work.width-1076)/2),y:Math.round(work.y+(work.height-453)/2),width:1076,height:453};
    }
  }
  const current=overlay.getBounds();
  if(Object.keys(bounds).some(k=>bounds[k]!==current[k]))overlay.setBounds(bounds,false);
  const appearing=!overlay.isVisible();
  if(appearing)overlay.showInactive();
  // Windows can put it behind League even though it asks to stay on top, and then "open" is all
  // anyone can see of it. Raised as it appears, then once a second, without taking focus.
  if(!preview&&process.platform==='win32'&&(appearing||Date.now()>=nextPanelRaise)){
    nextPanelRaise=Date.now()+1000;
    // A window that has just appeared never has the flag yet (a hidden one does not take it), so only a later loss is news.
    try{if(tracker.raisePanel(overlay.getNativeWindowHandle())&&!appearing)errorLog.note('panel','it had lost always-on-top; raised it');}catch{/* It stays where it is. */}
  }
  syncOutsideClicks();
}

async function handleAction({kind,id,fromHistory=false}={}) {
  if(kind==='minimize-window'){hideDashboard();place();return;}
  if(kind==='open-dashboard'){if(launcherAllowed())showDashboard();return;}
  if(kind==='paste-code')return clipboard.readText();
  if(kind==='hide-window'){hideDashboard();return;}
  if(kind==='set-setting'){
    const previous=state.settings?.[id?.key];
    state.settings=await settingsStore.set(id?.key,id?.value);
    if(id.key==='startWithWindows'){
      try{configureLogin();}
      catch(error){
        try{state.settings=await settingsStore.set(id.key,previous);configureLogin();}catch{}
        emitState();throw error;
      }
    }
    if(id.key==='guideHotkey')guide.setShortcut(id.value);
    emitState();return;
  }
  if(kind==='guide-capture'){guide.setCapture(!!id);return;}
  if(kind==='check-updates'){void runChecks({manual:true});return;}
  if(kind==='check-databases'){void checkDatabases();return;}
  if(kind==='send-logs'){void sendLogs(typeof id==='string'?id:'');return;}
  if(kind==='open-logs'){
    if(preview)return;
    const error=await shell.openPath(app.getPath('userData'));
    if(error)throw new Error(`Could not open the logs folder: ${error}`);
    return;
  }
  if(kind==='run-diagnostics'){
    if(preview||state.diagnosticsBusy||process.platform!=='win32')return;
    state.diagnosticsBusy=true;state.diagnosticsStatus='Running Windows diagnostics…';emitState();
    const {execFile}=require('node:child_process');
    const script=path.join(__dirname,'diagnostics','Diagnose-Friloverse.ps1');
    const outDir=path.join(app.getPath('userData'),'diagnostics',`Friloverse-Diagnostics-${new Date().toISOString().replace(/[:.]/g,'-')}`);
    const psExe=path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
    try{
      await new Promise((resolve,reject)=>{
        execFile(psExe,['-NoProfile','-ExecutionPolicy','Bypass','-File',script,'-AppPath',path.dirname(process.execPath),'-DataPath',app.getPath('userData'),'-OutputDirectory',outDir,'-AppVersion',app.getVersion()],{windowsHide:true,timeout:180000},err=>err?reject(err):resolve());
      });
      state.diagnosticsStatus='Diagnostics finished.';
      void shell.openPath(outDir);
    }catch(error){
      state.diagnosticsStatus=`Diagnostics failed: ${error.message}`;
    }finally{state.diagnosticsBusy=false;emitState();}
    return;
  }
  if(kind==='dismiss-issue'&&typeof id==='string'){
    if(diagnostics?.dismiss(id)){state.issues=diagnostics.snapshot();emitState();}
    return;
  }
  if(kind==='clear-issues'){
    if(diagnostics?.clear()){state.issues=diagnostics.snapshot();emitState();}
    return;
  }
  if(kind==='random-skin'){
    const scope=typeof id==='string'?id:'';
    const pool=(state.skins||[]).filter(skin=>!skin.broken&&(
      scope==='riot'?skin.kind==='riot':
      scope==='local'?skin.source==='local':
      scope==='custom'?skin.kind!=='riot'&&skin.source!=='local':true
    ));
    if(!pool.length)return;
    const currentId=choices?.pick(state.champion)?.id||'';
    const candidates=pool.length>1?pool.filter(s=>s.id!==currentId&&!s.chromas?.some(c=>c.id===currentId)):pool;
    const pickFrom=candidates.length?candidates:pool;
    // Two-stage uniform random (matching Rose): pick skin first, then [skin, ...chromas].
    const chosen=pickFrom[Math.floor(Math.random()*pickFrom.length)];
    const variants=[chosen,...(chosen.chromas||[])];
    const target=variants[Math.floor(Math.random()*variants.length)];
    return handleAction({kind:'select',id:target.id});
  }
  if(kind==='emergency-disable-mods'){
    if(preview)return;
    emergencyModsOff=true;
    if(state.champion)choices.drop(state.champion);
    state.restoredSkin=null;
    engine.setPersonal(null);
    engine.setMods([]);
    party.refreshLocal();
    await engine.endPatching().catch(()=>{});
    emitState();return;
  }
  if(kind==='swiftplay-slot'){
    const index=Number(id);
    if(Number.isInteger(index)&&index>=0){swiftplaySlot=index;void poll();}
    return;
  }
  if(kind==='dismiss-restored'){
    const champ=state.champion;
    state.restoredSkin=null;
    if(champ){skinHistory?.clear(champ);return handleAction({kind:'disable-skin',id:choices?.pick(champ)?.id||''});}
    emitState();return;
  }
  if(kind==='open-library-folder'){
    if(!['skins','mods','local'].includes(id))throw new Error('Unknown library folder.');
    if(preview)return;
    // LocalSkins is made again, with every champion's folder, if the player removed it.
    if(id==='local')await localSkinsFolders();
    const folder=id==='skins'?database.root:id==='local'?localDatabase.root:modDatabase.root;
    let info;try{info=await fs.lstat(folder);}catch(error){if(error.code==='ENOENT')throw new Error('This library folder does not exist yet.');throw error;}
    if(!info.isDirectory()||info.isSymbolicLink())throw new Error('This library folder is not a normal directory.');
    const error=await shell.openPath(folder);if(error)throw new Error(`Could not open the library folder: ${error}`);
    return;
  }
  if(kind==='divine-browse'){
    if(preview||state.divineBusy)return;
    state.divineBusy=true;state.divineMessage='';emitState();
    try{
      await require('./divine-browser.cjs').browseDivine({parent:dashboard,root:localDatabase.root,champions:state.champions,
        reportsAllowed:()=>state.settings?.reportDownloads!==false,
        onImported:(_saved,message)=>{customCards=null;state.divineMessage=message;emitState();}});
    }catch(error){state.divineMessage=error.message;}
    finally{state.divineBusy=false;emitState();}
    return;
  }
  if(kind==='refresh-custom-mods'){await refreshCustomMods();return;}
  if(kind==='toggle-custom-mod'){
    if(preview||state.modsPending||typeof id?.id!=='string'||typeof id?.enabled!=='boolean')return;
    state.modsPending=id.id;state.modsError='';state.modsNotice='';emitState();
    try{
      await customMods.setEnabled(id.id,id.enabled);
      if(!await noGameProcess())state.modsNotice='Saved. This applies from the next match.';
    }catch(error){state.modsError=error.message;}
    finally{state.modsPending='';await refreshCustomMods({preserveError:true});}
    return;
  }
  if(kind==='expand'||kind==='collapse') {
    if(state.champion){state.mode=kind==='expand'?'open':'tab';place();emitState();}
    return;
  }
  if(kind==='connect'&&!preview) {
    if(installingLtk)return;
    installingLtk=true;state.ltkInstalling=true;state.ltkInstallError='';emitState();
    try{
      const {installLtk}=await import('./ltk-install.mjs');
      await installLtk({dir:path.join(app.getPath('temp'),'friloverse-ltk'),onProgress:step=>setTask('ltk',step.phase==='download'
        ?{label:'Downloading LTK Manager',unit:'bytes',value:step.bytes,max:step.total,indeterminate:!step.total,
          then:'Checking LTK Manager',thenDetail:'Making sure it is the official file'}
        :{label:'Installing LTK Manager',detail:'Windows asks for your permission',indeterminate:true})});
      ltkFound=true;
    }catch(error){state.ltkInstallError=error.message;}
    finally{installingLtk=false;state.ltkInstalling=false;setTask('ltk',null);nextLtkCheck=0;await poll();emitState();}
    return;
  }
  if(kind==='open-party') {
    if(!syncDraftVisibility())return;
    if(!state.partyDocked){
      savedDashboard={bounds:dashboard.getBounds(),visible:dashboard.isVisible(),minimized:dashboard.isMinimized()};
      // With no League window to sit on, this is simply the dashboard.
      state.partyDocked=preview||dockDashboard();
    }
    // A manually opened Party view never stays on top of other programs.
    if(state.champion)state.mode='tab';
    revealDashboard();place();emitState();syncOutsideClicks();return;
  }
  if(kind==='close-party') {
    restoreDashboard();if(!preview)tracker.focusClient();place();emitState();syncOutsideClicks();return;
  }
  if(kind==='party-enter') {
    if(preview){
      if(!String(id?.name||'').trim())throw new Error('Enter your name first.');
      if(id?.mode==='join'&&!/^[A-Z0-9]{4}$/.test(String(id?.code||'')))throw new Error('Enter a four-character party code.');
      state.party={...state.party,status:'connected',code:'TEST',profile:{name:id.name||'Player',icon:id.icon||''},selfId:'preview',members:[{id:'preview',name:id.name||'Player',icon:id.icon||'',host:true,playing:'aatrox',skin:{relative:'Bellion Aatrox'},art:{image:'artwork/bellion.webp'},preparation:'armed'}]};emitState();return;
    }
    return party.enter(id?.mode,id);
  }
  if(kind==='party-profile') {
    if(preview){
      const recent=state.party.profile?.recentIcons||[];
      const recentIcons=id?.rememberIcon&&id.icon?[String(id.icon),...recent.filter(icon=>icon!==String(id.icon))].slice(0,6):recent;
      state.party={...state.party,profile:{name:id?.name||'',icon:id?.icon||'',recentIcons}};emitState();return;
    }
    return party.saveProfile(id?.name,id?.icon,{rememberIcon:id?.rememberIcon===true});
  }
  if(kind==='party-leave') {if(preview){state.party={...state.party,status:'idle',code:'',members:[]};emitState();return;}return party.leave();}
  if(kind==='party-kick'){
    if(preview){state.party={...state.party,members:state.party.members.filter(member=>member.id!==id)};emitState();return;}
    if(!party.kick(id))throw new Error('That player can be removed once the party has reconnected.');
    return;
  }
  if(kind==='party-stealth'){
    if(preview){
      const stealth=id===true;
      state.party={...state.party,stealth,members:state.party.members.map(member=>member.id==='preview'?member:stealth?{...member,playing:null,skin:null,art:null,hidden:true}:{...member,playing:'ahri',skin:{relative:'Star Guardian Ahri',championId:'ahri'},art:{image:'artwork/bellion.webp'},hidden:false})};
      emitState();return;
    }
    party.setStealth(id===true);return;
  }
  if(kind==='copy-logs-code'){if(state.logsCode)clipboard.writeText(state.logsCode);return;}
  if(kind==='party-copy'){if(state.party?.code)clipboard.writeText(state.party.code);return;}
  if(kind==='party-retry'){if(!preview)await party.retry();return;}
  if(preview&&['select','disable-skin'].includes(kind)){
    const on=kind==='select';
    state.skins=state.skins.map(skin=>{
      const chromas=skin.chromas?.map(chroma=>({...chroma,enabled:chroma.id===id&&on}));
      return {...skin,...(chromas?{chromas}:{}),enabled:(skin.id===id&&on)||!!chromas?.some(chroma=>chroma.enabled)};
    });
    emitState();return;
  }
  if(!['select','disable-skin'].includes(kind) || preview || typeof id!=='string') return;
  // Changing your mind quickly is never lost: the newest click runs when this one is done.
  if(actionBusy){queuedSkin={kind,id};return;}
  const champion=state.champion;
  if(!champion)return;
  // Claim the action before any await, so a second click cannot pass this guard too.
  actionBusy=true;state.pending=id;lastSkinClick=id;state.error='';emitState();
  try {
    if(!state.connected){
      ltkFound=await resolveLtkExecutable().then(()=>true,()=>false);
      state.connected=ltkFound;
      if(!ltkFound){state.error='LTK Manager is not ready yet. Install it from the Friloverse dashboard, then try again.';return;}
    }
    if(!hold.choicesOpen()&&!state.swiftplay?.active){state.error='League is about to open, so skins can no longer change for this match.';return;}
    if(kind==='select'){
      const label=skinLabel(id),draft=guideWatcher.draftId;
      await choices.choose(id,champion,label);
      // 12.6: building or downloading can take seconds. A draft that ended meanwhile (a dodge
      // and a new draft) starts with skins off, so this late pick must not reach it.
      if(guideWatcher.draftId!==draft){choices.drop(champion);return;}
      if(!fromHistory){state.restoredSkin=null;if(typeof skinHistory!=='undefined'&&skinHistory)skinHistory.set(champion,{id,label});}
    }else{
      choices.drop(champion);
      state.restoredSkin=null;
      if(!fromHistory&&typeof skinHistory!=='undefined'&&skinHistory)skinHistory.clear(champion);
    }
    engine.setPersonal(choices.pick(champion));
    party.refreshLocal();
  } catch(e){
    state.error=e.message;
    if(tray&&!tray.isDestroyed()&&!await noGameProcess()){
      try{tray.displayBalloon({title:'Friloverse skin update',content:e.message});}catch{}
    }
  }
  finally{
    actionBusy=false;state.pending='';
    // Said at once: the poll that follows can take a moment.
    const picked=choices.pick(champion)?.id||'';
    if(state.champion===champion)state.skins=state.skins.map(skin=>markPicked(skin,picked));
    emitState();
    if(queuedSkin){const next=queuedSkin;queuedSkin=null;void handleAction(next).catch(()=>{});}
    else{await poll();emitState();}
  }
}

function skinLabel(id){
  for(const skin of state.skins){
    if(skin.id===id)return skin.name;
    const chroma=skin.chromas?.find(item=>item.id===id);
    if(chroma)return `${skin.name} (${chroma.name})`;
  }
  return '';
}

const endWindowsSession=require('./session-end.cjs').sessionEndHandler({
  stop:()=>{
    closed=true;clearInterval(timer);clearInterval(riotHourly);clearInterval(riotFiveMinute);riotRetry.cancel();
    hold?.dispose();outsideClicks?.stop();guideWatcher?.stop();guide?.dispose();
  },
  restore:async()=>{
    if(preview)return;
    // Start independently: an unavailable relay must not delay the engine journal cleanup.
    await Promise.allSettled([party?.leave(),engine?.shutdown()]);
    party?.dispose();
  },
  onError:error=>errorLog.note('session-end',String(error.message||error)),
});
app.on('browser-window-created',(_event,window)=>window.on('session-end',endWindowsSession));

app.on('before-quit',event=>{
  // Windows ending the session stopped things itself (closed, not quitting): let it go.
  if(quitReady||closed&&!quitting)return;
  // A second Quit (the tray clicked twice) waits for the first one's clean-up to finish.
  event.preventDefault();
  if(quitting)return;
  quitting=true;closed=true;clearInterval(timer);clearInterval(riotHourly);clearInterval(riotFiveMinute);riotRetry.cancel();hold?.dispose();outsideClicks?.stop();guideWatcher?.stop();guide?.dispose();
  const restore=async()=>{
    if(party&&!preview){
      await party.leave();
      await party.profileQueue;
      await engine.shutdown();
    }
  };
  // Nothing on screen while this waits: to the player the app has closed.
  for(const window of BrowserWindow.getAllWindows())window.hide();
  finishWithin(restore(),QUIT_LIMIT).then(finished=>{
    if(!finished)errorLog.note('quit',`putting things back took over ${QUIT_LIMIT/1000} s; the next start finishes it`);
  }).finally(()=>{party?.dispose();tray?.destroy();quitReady=true;app.quit();});
});
app.on('window-all-closed',()=>{if(!quitting||quitReady)app.quit();});
