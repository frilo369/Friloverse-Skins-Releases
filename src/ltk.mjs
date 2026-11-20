import {createRequire} from 'node:module';
import {spawn,execFile} from 'node:child_process';
import {access,mkdir,open,readFile,readdir,writeFile,rename,unlink} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import path from 'node:path';
import {promisify} from 'node:util';
import {unwrap} from './model.mjs';
import {processRunning} from './process-list.mjs';
import {leagueFolder} from './league-client.mjs';
import {readWadFileOnDisk} from './skin-slots.mjs';

const execFileAsync=promisify(execFile);
const EXE='ltk-manager.exe',HOST='ltk_patcher_host.exe';
const REGISTRY_SUFFIX='Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\LTK Manager';
export const COMMANDS={
  mods:'plugin:library|get_installed_mods',install:'plugin:library|install_mod',uninstall:'plugin:library|uninstall_mod',toggle:'plugin:library|toggle_mod',repair:'plugin:library|repair_mod',
  checkHealth:'plugin:library|check_mod_health',
  stop:'plugin:patcher|stop_patcher',status:'plugin:patcher|get_patcher_status',
  info:'plugin:desktop|get_app_info',settings:'plugin:settings|get_settings',saveSettings:'plugin:settings|save_settings',detectLeague:'plugin:settings|auto_detect_league_path',
};
const ALLOWED=new Set(Object.values(COMMANDS));
const LONG=new Set([COMMANDS.install,COMMANDS.repair,COMMANDS.checkHealth]);
// Tested with this LTK Manager. A newer one is used too, and the player is told.
export const TESTED_VERSION='1.33.0';
// File/connection reads stay quick; process snapshots are synchronous and less frequent.
const CONNECT_RETRY=100,PROCESS_POLL=200,VERDICT_POLL=40;
// A large mod takes LTK several seconds to check. A later pass can fix what an earlier one
// skipped: its audio repair only applies once the rest of the mod reads.
const VERDICT_WAIT=20000,REPAIR_PASSES=3;
// An LTK Manager started as the last one was closing can exit at once.
const LAUNCH_CHECK=3000,RELAUNCHES=1;
// LTK builds the whole overlay before its host starts. A friend's PC took 37 s (2026-11-09); a
// limit of 30 s killed each working build, and three fresh builds outlasted League's 50 s hold.
// Only an LTK that has really gone is given up on early.
const PATCH_WAIT=120000,MANAGER_LOOK=1000,MANAGER_GONE=6000;

function plain(message){const error=new Error(message);error.plain=true;return error;}

export function parseInstallLocation(output,env=process.env){
  const match=String(output).match(/^\s*InstallLocation\s+REG_(?:EXPAND_)?SZ\s+(.+?)\s*$/im);
  if(!match)return null;
  let value=match[1].trim();
  if(value.startsWith('"')&&value.endsWith('"'))value=value.slice(1,-1);
  value=value.replace(/%([^%]+)%/g,(original,name)=>{
    const key=Object.keys(env).find(key=>key.toLowerCase()===name.toLowerCase());
    return key===undefined?original:env[key];
  });
  return !value.includes('%')&&path.win32.isAbsolute(value)?value:null;
}

/** The installer's registered folder first, so a custom folder works too. */
export async function resolveLtkExecutable({env=process.env,query=execFileAsync,canAccess=access}={}){
  const folders=[];
  for(const root of ['HKLM','HKCU'])for(const view of ['64','32']){
    try{
      const result=await query('reg.exe',['query',`${root}\\${REGISTRY_SUFFIX}`,'/v','InstallLocation',`/reg:${view}`],{windowsHide:true,timeout:5000});
      const folder=parseInstallLocation(result.stdout,env);
      if(folder&&!folders.some(other=>other.toLowerCase()===folder.toLowerCase()))folders.push(folder);
    }catch{}
  }
  if(env.ProgramW6432)folders.push(path.win32.join(env.ProgramW6432,'LTK Manager'));
  if(env.ProgramFiles)folders.push(path.win32.join(env.ProgramFiles,'LTK Manager'));
  if(env.LOCALAPPDATA)folders.push(path.win32.join(env.LOCALAPPDATA,'LTK Manager'));
  for(const folder of folders){
    const executable=path.win32.join(folder,EXE);
    try{await canAccess(executable);return executable;}catch{}
  }
  throw plain('LTK Manager was not found. Run the Friloverse setup again to install it.');
}

export const ltkRunning=()=>processRunning(EXE);
export const settingsFile=(env=process.env)=>path.join(env.APPDATA,'dev.leaguetoolkit.manager','settings.json');
export const verdictsFile=(env=process.env)=>path.join(env.APPDATA,'dev.leaguetoolkit.manager','mod-health-verdicts.json');
/** When LTK's patcher last began scanning for a game, by its own log. 0 if unknown. */
export async function lastScanStart(dir=path.join(process.env.APPDATA||'','dev.leaguetoolkit.manager','logs')){
  const newest=(await readdir(dir)).filter(name=>name.endsWith('.log')).sort().at(-1);
  if(!newest)return 0;
  const file=await open(path.join(dir,newest));
  try{
    const {size}=await file.stat(),length=Math.min(size,512*1024);
    const {buffer}=await file.read(Buffer.alloc(length),0,length,size-length);
    const line=buffer.toString('utf8').split('\n').reverse().find(row=>row.includes('session started: scanning for game'));
    return line?Date.parse(line.slice(0,27))||0:0;
  }finally{await file.close();}
}
/**
 * Which champions or required skin slots are missing from the overlay LTK last built, by its log's
 * root. An empty list also means it could not tell: this may never be a reason to hold a game.
 */
export async function missingFromOverlay(champions,dir=path.join(process.env.APPDATA||'','dev.leaguetoolkit.manager','logs'),slots=new Map()){
  const newest=(await readdir(dir)).filter(name=>name.endsWith('.log')).sort().at(-1);
  if(!newest)return [];
  const file=await open(path.join(dir,newest));
  let root='';
  try{
    const {size}=await file.stat(),length=Math.min(size,512*1024);
    const {buffer}=await file.read(Buffer.alloc(length),0,length,size-length);
    root=/Using overlay root: (.+)/.exec(buffer.toString('utf8').split('\n').reverse().find(row=>row.includes('Using overlay root: '))||'')?.[1].trim()||'';
  }finally{await file.close();}
  if(!root)return [];
  const folder=path.join(root,'DATA','FINAL','Champions');
  const names=await readdir(folder).catch(()=>null);
  if(!names)return [];
  const missing=await Promise.all(champions.map(async champion=>{
    const alias=String(champion).toLowerCase(),slot=slots.get(champion);
    if(slot){
      const wad=names.find(name=>name.toLowerCase()===`${alias}.wad.client`);
      return !wad||!await readWadFileOnDisk(path.join(folder,wad),`data/characters/${alias}/skins/skin${slot}.bin`).catch(()=>null);
    }
    return !names.some(name=>name.toLowerCase().startsWith(`${alias}.`)&&name.toLowerCase().endsWith('.wad.client'));
  }));
  return champions.filter((_,index)=>missing[index]);
}
const require=createRequire(import.meta.url);
const {PREFERENCE}=require('./ltk-preference.cjs');
// Loaded at the first start of LTK Manager: it needs Windows.
const openDebugPipes=()=>require('./ltk-pipe.cjs').openDebugPipes();
const QUIET_SETTINGS={startInTray:true,minimizeToTray:true,startInTrayUnlessUpdate:false};
// What LTK Manager needs on a new PC, so its welcome window never opens. It falls back
// to its own defaults if a later version wants more.
const FIRST_START={firstRunComplete:true,theme:'system',accentColor:{preset:null,customHue:null},backdropImage:null,backdropBlur:null,libraryViewMode:null,...PREFERENCE};

/** LTK Manager's own "always start the patcher on launch" choice. */
export async function readPatcherAtStart(file=settingsFile()){
  try{return JSON.parse(await readFile(file,'utf8'))?.alwaysStartPatcher===true;}
  catch{return false;}
}
const FILE_BUSY=new Set(['EPERM','EBUSY','EACCES']),SETTINGS_RETRIES=[50,100,200,400,800,1200,null];
const SETTINGS_BUSY="LTK Manager's settings file is busy. Friloverse tries again by itself.";
function parsedSettings(text){
  try{
    const settings=JSON.parse(text.replace(/^\uFEFF/,''));
    return settings&&typeof settings==='object'&&!Array.isArray(settings)?settings:null;
  }catch{return null;}
}
/** LTK Manager's own start-up choices, set only while it is closed. */
export async function prepareQuietStart(file=settingsFile(),{isRunning=ltkRunning,league=leagueFolder,patcherAtStart=false,renameFile=rename,readText=readFile,pause=ms=>new Promise(done=>setTimeout(done,ms))}={}){
  if(await isRunning())return false;
  let text=null;
  for(const wait of SETTINGS_RETRIES){
    try{text=await readText(file,'utf8');break;}
    catch(error){
      if(error?.code==='ENOENT')break;
      if(!FILE_BUSY.has(error?.code))throw error;
      if(wait===null)throw plain(SETTINGS_BUSY);
      await pause(wait);
    }
  }
  let settings=text===null?null:parsedSettings(text);
  if(!settings){
    // Left unreadable (a power cut while saving, say), the patcher would never start and
    // every skin would fail. What it held is kept beside it.
    if(text!==null)await writeFile(`${file}.broken`,text,'utf8').catch(()=>{});
    settings={...FIRST_START,leaguePath:await league().catch(()=>null)};
    await mkdir(path.dirname(file),{recursive:true});
  }
  const wanted={...QUIET_SETTINGS,alwaysStartPatcher:patcherAtStart};
  if(Object.entries(wanted).every(([key,value])=>settings[key]===value))return false;
  const tmp=`${file}.friloverse-${randomBytes(8).toString('hex')}.tmp`;
  try{
    await writeFile(tmp,JSON.stringify({...settings,...wanted},null,2),{encoding:'utf8',flag:'wx'});
    // Windows can keep the file locked for a moment after LTK Manager has closed.
    for(const wait of SETTINGS_RETRIES){
      if(await isRunning())return false;
      try{await renameFile(tmp,file);return true;}
      catch(error){
        if(!FILE_BUSY.has(error?.code))throw error;
        if(wait===null)throw plain(SETTINGS_BUSY);
        await pause(wait);
      }
    }
  }finally{await unlink(tmp).catch(()=>{});}
  return false;
}

/**
 * Uses the real LTK Manager in two steps. To change its library, Friloverse starts it
 * with two private pipes to its window (`ltk-pipe.cjs`) and calls its own commands, the
 * way its window does. No network port is opened, so no other program can send it
 * commands. To patch a match, that one is closed and LTK Manager is started normally:
 * it restarts itself through the Windows shell and starts its patcher by its own
 * setting. LTK's game helper refuses an overlay from a manager that is not a child of
 * the shell, so the one with the pipes must never patch. Friloverse never starts LTK's
 * host or DLL.
 */
export class LtkBridge{
  constructor({openChannel=openDebugPipes,spawnProcess=spawn,resolve=resolveLtkExecutable,isRunning=ltkRunning,hostRunning=()=>processRunning(HOST),prepare=prepareQuietStart,pause=ms=>new Promise(done=>setTimeout(done,ms)),taskkill=execFileAsync}={}){
    Object.assign(this,{openChannel,spawnProcess,resolve,isRunning,hostRunning,prepare,pause,taskkill});
    this.serial=0;this.pending=new Map();this.channel=null;this.session='';this.version='';this.notice='';this.child=null;this.patchChild=null;this.connecting=null;
  }
  get connected(){return !!this.session&&this.linked;}
  get ownsEditor(){return !!this.child?.pid&&this.child.exitCode==null&&this.child.signalCode==null;}
  /** Only the pipes handed to the editing LTK Manager Friloverse started are ever spoken to. */
  get linked(){return this.ownsEditor&&this.channel?.open===true;}
  /**
   * Connect, starting LTK Manager if needed. One opened another way is left alone, unless
   * `takeOver`: a skin is waiting, and a player was never meant to need it open.
   */
  async ensure({timeout=30000,takeOver=false}={}){
    if(this.connected)return;
    if(this.connecting)return this.connecting;
    const attempt=this.open(timeout,takeOver);this.connecting=attempt;
    try{return await attempt;}finally{if(this.connecting===attempt)this.connecting=null;}
  }
  async open(timeout,takeOver=false){
    let launched=false;
    if(!this.linked){
      if(await this.isRunning()){
        const message='LTK Manager is already open. Close it (also from the system tray) so Friloverse can use it.';
        // Friloverse's own editing one that lost its pipes is of no use to anybody.
        if(!takeOver&&!this.ownsEditor)throw plain(message);
        await this.killAll();
        await this.closed().catch(()=>{throw plain(message);});
      }
      await this.launch();launched=true;
    }
    const deadline=Date.now()+timeout;let last,relaunches=RELAUNCHES,checkAt=Date.now()+LAUNCH_CHECK;
    while(Date.now()<deadline){
      try{await this.attach();return;}
      catch(error){last=error;await this.pause(CONNECT_RETRY);}
      if(launched&&relaunches>0&&Date.now()>=checkAt){
        checkAt=Date.now()+LAUNCH_CHECK;
        if(!await this.isRunning()){relaunches--;await this.launch();}
      }
    }
    // A hung one would answer no better next time: the retry starts from nothing.
    await this.quit().catch(()=>{});
    throw plain(`LTK Manager did not answer. ${last?.message||''}`.trim());
  }
  /** By name: its first process number is long gone after its restart, and may be someone else's by now. */
  killAll(taskkill=this.taskkill){
    return Promise.resolve(taskkill('taskkill',['/F','/T','/IM',EXE],{windowsHide:true,timeout:5000})).catch(()=>{});
  }
  /** Where it is installed does not change between the two starts of one pick. */
  executable(){
    if(!this.found)this.found=this.resolve().catch(error=>{this.found=null;throw error;});
    return this.found;
  }
  async launch(){
    const executable=await this.executable();
    await this.prepare(undefined,{patcherAtStart:false});
    if(this.channel)this.drop(this.channel);
    const channel=await this.openChannel();
    let child;
    try{
      // The flag stops LTK restarting itself through the Windows shell, which would lose
      // the pipes. Only this child gets them, and it only edits the library.
      channel.share();
      child=this.spawnProcess(executable,['--shell-relaunched'],{detached:true,stdio:'ignore',windowsHide:true,
        env:{...process.env,WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:channel.browserArguments}});
    }catch(error){channel.close();throw error;}
    finally{channel.release();}
    try{await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});}
    catch(error){channel.close();throw error;}
    child.unref();this.child=child;this.listen(channel);
    return child.pid;
  }
  /** Its answers arrive as JSON texts, each ended by a zero byte. */
  listen(channel){
    this.channel=channel;
    let rest=Buffer.alloc(0);
    channel.receive.on('data',chunk=>{
      rest=rest.length?Buffer.concat([rest,chunk]):chunk;
      for(let end=rest.indexOf(0);end!==-1;end=rest.indexOf(0)){
        const text=rest.toString('utf8',0,end);rest=rest.subarray(end+1);
        let message;try{message=JSON.parse(text);}catch{continue;}
        const waiting=this.pending.get(message?.id);
        if(!waiting||waiting.channel!==channel)continue;
        this.pending.delete(message.id);clearTimeout(waiting.timer);
        if(message.error)waiting.reject(new Error(message.error.message??'LTK Manager rejected the request.'));
        else waiting.resolve(message.result);
      }
    });
    const dropped=()=>this.drop(channel);
    for(const side of [channel.send,channel.receive]){side.on('close',dropped);side.on('error',dropped);}
  }
  async attach(){
    if(!this.linked)throw plain('LTK Manager\'s editing process has closed. Try choosing the skin again.');
    const channel=this.channel;
    const targets=(await this.command('Target.getTargets',{},2000))?.targetInfos;
    const page=Array.isArray(targets)&&targets.find(item=>item?.type==='page'&&typeof item.url==='string'&&/^https?:\/\/tauri\.localhost\//.test(item.url));
    if(!page)throw new Error('Its window is still loading.');
    const session=(await this.command('Target.attachToTarget',{targetId:page.targetId,flatten:true},3000))?.sessionId;
    if(!session||this.channel!==channel)throw new Error('Its window is still loading.');
    this.session=session;
    try{
      if(await this.evaluate('!!window.__TAURI_INTERNALS__?.invoke',5000)!==true)throw new Error('Its window is still loading.');
      const info=await this.invoke(COMMANDS.info);
      this.version=String(info?.version||'');
      this.notice=this.version&&this.version!==TESTED_VERSION?`LTK Manager ${this.version} is not the version Friloverse was tested with. If a skin does not apply, use Check for updates in Settings.`:'';
      await this.finishFirstRun();
    }catch(error){
      if(this.session===session)this.session='';
      this.command('Target.detachFromTarget',{sessionId:session},2000,'',channel).catch(()=>{});
      throw error;
    }
  }
  /** Nobody should have to open LTK Manager to tell it where League is. */
  async finishFirstRun(){
    const settings=await this.invoke(COMMANDS.settings);
    if(settings?.leaguePath&&settings.firstRunComplete)return;
    const found=settings?.leaguePath||await this.invoke(COMMANDS.detectLeague).catch(()=>null)||await leagueFolder().catch(()=>null);
    if(found)await this.invoke(COMMANDS.saveSettings,{settings:{...settings,leaguePath:found,firstRunComplete:true}});
  }
  drop(channel){
    if(this.channel===channel){this.channel=null;this.session='';}
    channel.close();
    for(const [id,waiting] of this.pending){if(waiting.channel===channel){this.pending.delete(id);clearTimeout(waiting.timer);waiting.reject(new Error('LTK Manager closed.'));}}
  }
  /** One request to LTK Manager's browser; with `session`, to its window. */
  command(method,params,timeout,session='',channel=this.channel){
    return new Promise((resolve,reject)=>{
      if(!channel?.open)return reject(new Error('LTK Manager is not connected.'));
      const id=++this.serial;
      const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error('LTK Manager did not respond in time.'));},timeout);
      this.pending.set(id,{resolve,reject,timer,channel});
      channel.send.write(`${JSON.stringify({id,method,params,...(session?{sessionId:session}:{})})}\0`,error=>{
        if(error&&this.pending.delete(id)){clearTimeout(timer);reject(new Error('LTK Manager closed while sending the request.'));}
      });
    });
  }
  async evaluate(expression,timeout=20000){
    if(!this.session)throw new Error('LTK Manager is not connected.');
    const result=await this.command('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true},timeout,this.session);
    if(result?.exceptionDetails)throw new Error(result.exceptionDetails.exception?.description??'LTK Manager rejected the request.');
    return result?.result?.value;
  }
  async invoke(command,args){
    if(!ALLOWED.has(command))throw new Error('Unsupported LTK Manager command.');
    const text=`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)},${JSON.stringify(args??{})})`;
    return unwrap(await this.evaluate(text,LONG.has(command)?180000:20000));
  }
  mods(){return this.invoke(COMMANDS.mods);}
  status(){return this.invoke(COMMANDS.status);}
  install(filePath){return this.invoke(COMMANDS.install,{filePath});}
  uninstall(modId){return this.invoke(COMMANDS.uninstall,{modId});}
  toggle(modId,enabled){return this.invoke(COMMANDS.toggle,{modId,enabled});}
  /** LTK Manager's own Repair, on its own copy of the mod. */
  repair(modId){return this.invoke(COMMANDS.repair,{modId});}
  /** LTK's real content check, separate from its spoofable UI badge getter. */
  checkHealth(modId){return this.invoke(COMMANDS.checkHealth,{modId});}
  stop(){return this.invoke(COMMANDS.stop);}
  /** LTK's own verdict on an installed mod: the next one if `previous` is given. */
  async verdict(modId,{file=verdictsFile(),timeout=VERDICT_WAIT,previous=''}={}){
    const deadline=Date.now()+timeout;
    do{
      const found=await readFile(file,'utf8').then(text=>{
        try{return JSON.parse(text)?.verdicts?.[modId];}catch{return null;}
      },()=>null);
      if(found&&JSON.stringify(found)!==previous)return found;
      await this.pause(VERDICT_POLL);
    }while(Date.now()<deadline);
    return null;
  }
  /**
   * What LTK's window does for a player: most custom skins were made for an older League
   * and need its Repair, which changes only LTK's copy. Returns what still stops the mod
   * from loading: 'skinhack' turns the whole overlay off in the game, and a 'damaged' mod
   * can crash it. A background sweep may not have checked a newly installed mod yet;
   * ask LTK for a real check then, rather than letting it skip Repair without a verdict.
   */
  async readyMod(modId,{file=verdictsFile(),repair=true,timeout=VERDICT_WAIT}={}){
    let verdict=await this.verdict(modId,{file,timeout:0});
    if(!verdict)verdict=await this.checkHealth(modId);
    if(!verdict||verdict.modId!==undefined&&verdict.modId!==modId)throw plain('LTK Manager did not finish checking this skin. Choose it again to retry.');
    for(let pass=0;repair&&pass<REPAIR_PASSES&&verdict?.fixable>0;pass++){
      const previous=JSON.stringify(verdict);
      await this.repair(modId);
      const next=await this.verdict(modId,{file,timeout,previous});
      if(!next)break;
      verdict=next;
    }
    const rules=verdict?.rules||[];
    if(rules.some(rule=>rule?.rule==='bin/skinhack'&&rule.severity!=='info'))return 'skinhack';
    return rules.some(rule=>rule?.severity==='fatal')?'damaged':'';
  }
  patcherAtStart(){return readPatcherAtStart();}
  setPatcherAtStart(on){return this.prepare(undefined,{patcherAtStart:on});}
  async closed(timeout=10000){
    const started=Date.now(),deadline=started+timeout;let nudged=false;
    while(await this.isRunning()||await this.hostRunning()){
      if(Date.now()>=deadline)throw plain('LTK Manager did not close.');
      // Its host can outlive it, and nothing else will end that one.
      if(!nudged&&Date.now()-started>=timeout/2){
        nudged=true;
        await this.killAll();
        await Promise.resolve(this.taskkill('taskkill',['/F','/T','/IM',HOST],{windowsHide:true,timeout:5000})).catch(()=>{});
      }
      await this.pause(PROCESS_POLL);
    }
  }
  /** Whether LTK's patcher is still there for this match. */
  patcherAlive(){return this.hostRunning();}
  overlayMissing(champions,slots){return missingFromOverlay(champions,undefined,slots);}
  /**
   * Close the editing LTK Manager and start the one that patches this match. `stale` says the
   * skins have changed meanwhile: the start is then given up (false) instead of waited for, as
   * building the overlay takes seconds, and half a minute on a slow PC.
   */
  async patch({timeout=PATCH_WAIT,stale=()=>false}={}){
    const executable=await this.executable();
    await this.quit();
    await this.closed();
    await this.prepare(undefined,{patcherAtStart:true});
    const child=this.spawnProcess(executable,[],{detached:true,stdio:'ignore',windowsHide:true});
    this.patchChild=child;
    await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});
    child.unref();
    const deadline=Date.now()+timeout;
    let goneSince=0,lookAt=Date.now()+MANAGER_LOOK;
    while(!await this.hostRunning()){
      const now=Date.now();
      if(stale())return false;
      if(now>=deadline)throw plain('LTK Manager did not start its patcher. Try choosing the skin again.');
      if(now>=lookAt){
        lookAt=now+MANAGER_LOOK;
        // It restarts itself through the shell, so one look without it means nothing.
        if(await this.isRunning())goneSince=0;
        else if(!goneSince)goneSince=now;
        else if(now-goneSince>=MANAGER_GONE)throw plain('LTK Manager closed before its patcher started. Try choosing the skin again.');
      }
      await this.pause(PROCESS_POLL);
    }
    return true;
  }
  /** Close the LTK Manager that patch() started; it has no connection to ask. */
  async endPatching({taskkill=this.taskkill}={}){
    this.patchChild=null;
    await this.killAll(taskkill);
    await this.closed();
  }
  /** Stop talking to it but leave it running, for a game that still needs it. */
  detach(){
    if(this.channel)this.drop(this.channel);
    this.child=null;
  }
  /**
   * Close only an LTK Manager Friloverse started; one the player opened stays open.
   * After a restart the normal explicit take-over path handles an old manager when a
   * pick needs it.
   */
  async quit({taskkill=this.taskkill}={}){
    const ours=this.ownsEditor||this.patchChild?.pid;
    this.patchChild=null;
    this.detach();
    if(ours)await this.killAll(taskkill);
  }
}
