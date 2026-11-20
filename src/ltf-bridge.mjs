import {execFile,spawn} from 'node:child_process';
import {access,mkdir,readFile,rename,stat,unlink} from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {processRunning} from './process-list.mjs';
import {missingFromOverlay} from './ltk.mjs';

// The LeagueToolFlop (LTF) bridge, built from the MIT-licensed sources in `native/ltf`
// and shipped with Friloverse (see `native/ltf/NOTICE.md`). `ltk_launcher.exe` starts LTK
// Manager as a child of Explorer, hidden, and injects `LeagueToolFlop.dll`; the DLL serves a
// token-protected JSON API on 127.0.0.1 for importing skins, toggling mods, checking and
// repairing them, and starting/stopping LTK's patcher. Friloverse keeps that one manager
// alive for the session instead of closing and restarting it for every pick.
//
// Friloverse trusts only the real `check_mod_health` answer and the game's own overlay
// verification; the DLL's UI health spoof is never used as a verdict.
const HERE=path.dirname(fileURLToPath(import.meta.url));
export const TOOLS=path.join(HERE,'native','ltf');
export const LAUNCHER=path.join(TOOLS,'ltk_launcher.exe'),DLL=path.join(TOOLS,'LeagueToolFlop.dll');
const MANAGER='ltk-manager.exe',HOST='ltk_patcher_host.exe';
const LAUNCHER_TIMEOUT=60000,LAUNCH_TIMEOUT=30000,CDP_TIMEOUT=20000;
const API_TIMEOUT=120000,IMPORT_TIMEOUT=200000,PATCH_TIMEOUT=120000,STOP_TIMEOUT=120000;
const PATCHER_IDLE_GRACE=3000,PORT_POLL=100,CDP_POLL=500,PROCESS_POLL=200;
const LAUNCHER_LOG_MAX=1024*1024,INLINE_IMPORT_LIMIT=40*1024*1024;
const PORT_MIN=46321,PORT_MAX=46340;
const PUBLIC_PORT_FILE='C:\\Users\\Public\\LTKBridge.port';
const CDP_STARTING=/cdp unavailable|reading ['"]invoke['"]|__TAURI_INTERNALS__|no tauri/i;
const IMPORT_UNREADABLE=/not found:|cannot read file:|failed to read file:/i;
const PATCHER_MESSAGES={
  LEAGUE_ELEVATED:'League is running as administrator, so LTK Manager cannot reach it. Turn that off for League and try again.',
  MANAGER_ELEVATED:'LTK Manager is running as administrator, which it refuses. Close it from its tray icon and try again.',
  DLL_UNAVAILABLE:'LTK Manager could not get its game helper. Check your connection and try again.',
  UNSUPPORTED_PLATFORM:'LTK Manager does not support this version of Windows.',
  BUSY:'LTK Manager is busy right now. Try again in a moment.',
};

const plain=message=>Object.assign(new Error(message),{plain:true});
const execFileAsync=promisify(execFile);
const wait=ms=>new Promise(done=>setTimeout(done,ms));
const valueOf=reply=>reply?.response?.value??reply?.value??null;
const validPort=value=>Number.isInteger(value)&&value>0&&value<65536;
const validToken=value=>/^[0-9a-f]{32}$/i.test(String(value||''));

function describeLtkError(detail){
  const inner=detail?.error&&typeof detail.error==='object'?detail.error:null;
  const kind=inner?.kind||'';
  const outerCode=detail?.code||'';
  const code=kind||outerCode;
  const parts=[PATCHER_MESSAGES[code]||inner?.message||detail?.message||kind||outerCode||'LTK Manager refused the request.'];
  if(!PATCHER_MESSAGES[code]&&inner?.reason&&!parts[0].includes(inner.reason))parts.push(inner.reason);
  if(!PATCHER_MESSAGES[code]&&inner?.stage&&!parts[0].includes(inner.stage))parts.push(`(${inner.stage})`);
  const error=plain(parts.join(' ').trim());
  if(code)error.code=code;
  if(outerCode)error.outerCode=outerCode;
  return error;
}

/** Whether both bundled LTF files are present. */
export async function ltfAvailable({launcher=LAUNCHER,dll=DLL,canAccess=access}={}){
  if(process.platform!=='win32')return false;
  try{await canAccess(launcher);await canAccess(dll);return true;}catch{return false;}
}

/** Read a single REG_SZ/REG_DWORD value from HKCU\Software\LTKBridge without throwing. */
async function readRegistryBridge(exec=execFileAsync){
  if(process.platform!=='win32')return {port:0,token:''};
  try{
    const {stdout}=await exec('reg',['query','HKCU\\Software\\LTKBridge'],{windowsHide:true,timeout:2000});
    const portText=/ApiPort\s+REG_(?:DWORD|SZ)\s+(0x[0-9a-f]+|\d+)/i.exec(stdout)?.[1];
    const port=portText?Number(portText):0;
    const token=/ApiToken\s+REG_SZ\s+([0-9a-f]{32})/i.exec(stdout)?.[1]||'';
    return {port:validPort(port)?port:0,token:validToken(token)?token:''};
  }catch{return {port:0,token:''};}
}

/** Rotate `ltk_launcher.log` past 1 MB so old runs do not grow forever. */
async function rotateLauncherLog(logDir){
  const logFile=path.join(logDir,'ltk_launcher.log');
  const info=await stat(logFile).catch(()=>null);
  if(!info||info.size<=LAUNCHER_LOG_MAX)return;
  const oldFile=path.join(logDir,'ltk_launcher.old.log');
  await unlink(oldFile).catch(()=>{});
  await rename(logFile,oldFile).catch(()=>{});
}

/** Read the newest launcher error hint written since `offset`. */
async function readLauncherHint(logDir,offset){
  try{
    const text=await readFile(path.join(logDir,'ltk_launcher.log'),'utf8');
    const fresh=text.slice(offset);
    if(/helper spawn err=740/i.test(fresh))return 'ltk_launcher.exe is set to Run as administrator (error 740). Turn that off in its Properties.';
    const errLine=fresh.split(/\r?\n/).reverse().find(line=>/\[err\]|\[error\]|failed/i.test(line));
    return errLine?errLine.trim().slice(0,220):'';
  }catch{return '';}
}

/**
 * The part of LTK Manager's interface the skin engine uses, spoken through the bundled
 * LTF DLL instead of LTK's window. It only ever talks to the manager its own launcher
 * started, verified by the pid the launcher printed and `hello` returned.
 */
export class LtfBridge{
  constructor({launcher=LAUNCHER,dll=DLL,exePath=null,logDir=null,dataDir=process.env.APPDATA,
    isRunning=()=>processRunning(MANAGER),hostRunning=()=>processRunning(HOST),
    launch=null,taskkill=execFileAsync,pause=wait,now=Date.now,portFile=null,tokenFile=null,
    publicPortFile=PUBLIC_PORT_FILE,readRegistry=null,connect=null,launcherTimeout=LAUNCHER_TIMEOUT,
    cdpTimeout=CDP_TIMEOUT,stopTimeout=STOP_TIMEOUT,idleGrace=PATCHER_IDLE_GRACE}={}){
    this.launcher=launcher;this.dll=dll;this.exePath=exePath;
    this.dataDir=dataDir;
    this.logDir=logDir||path.join(dataDir||'.','friloverse-skins','ltf');
    this.isRunning=isRunning;this.hostRunning=hostRunning;
    this.taskkill=taskkill;this.pause=pause;this.now=now;
    this.bridgeDir=path.join(process.env.LOCALAPPDATA||dataDir||'.','LTKBridge');
    this.portFile=portFile||path.join(this.bridgeDir,'port.txt');
    this.tokenFile=tokenFile||path.join(this.bridgeDir,'token.txt');
    this.publicPortFile=publicPortFile;
    this.readRegistry=readRegistry||(portFile||tokenFile?async()=>({port:0,token:''}):()=>readRegistryBridge(this.taskkill));
    this.launch=launch||((args)=>spawn(launcher,args,{detached:true,stdio:['ignore','pipe','ignore'],windowsHide:true}));
    this.connect=connect||(options=>net.connect(options));
    this.launcherTimeout=launcherTimeout;this.cdpTimeout=cdpTimeout;
    this.stopTimeout=stopTimeout;this.idleGrace=idleGrace;
    this.port=0;this.token='';this.linked=false;this.child=null;this.notice='';this.managerPid=0;
  }
  get connected(){return this.linked&&this.port>0&&!!this.token;}
  /**
   * 12.6: whether the linked manager still answers. One closed from its tray or crashed takes
   * the DLL's port with it, and `connected` alone would keep every pick failing until the match
   * ended; a refused connection drops the link (see `request`) so `ensure` starts another.
   * A slow answer is not a gone manager.
   */
  async reachable(){
    try{await this.request('hello',{},{timeout:5000});}
    catch(error){if(error.unreachable)return false;}
    return this.connected;
  }
  /** Kill only our spawned manager pid when startup fails before the session is ready. */
  async killSpawned(pid){
    if(!pid)return;
    await Promise.resolve(this.taskkill('taskkill',['/F','/T','/PID',String(pid)],{windowsHide:true,timeout:5000})).catch(()=>{});
  }
  async waitForCdp(timeout=this.cdpTimeout){
    const deadline=this.now()+timeout;
    let lastError=null;
    while(true){
      try{
        await this.request('patcher_status',{},{timeout:20000});
        return;
      }catch(error){
        lastError=error;
        if(error.unreachable||!CDP_STARTING.test(String(error.message||''))||this.now()>=deadline)throw error;
      }
      await this.pause(CDP_POLL);
    }
  }
  async ensure({takeOver=false}={}){
    if(this.connected&&await this.reachable())return;
    if(await this.isRunning().catch(()=>false)){
      // As with the editing path: one the player opened is left alone while nothing is
      // waiting for it; a pick (takeOver) closes it and starts the bridged manager.
      if(!takeOver)throw plain('LTK Manager is already open. Close it (also from the system tray) so Friloverse can use it.');
      await this.killAll();await this.closed().catch(()=>{});
    }
    await mkdir(this.logDir,{recursive:true}).catch(()=>{});
    await rotateLauncherLog(this.logDir);
    const logOffset=await stat(path.join(this.logDir,'ltk_launcher.log')).then(info=>info.size,()=>0);
    const before=await this.fileTimes();
    const args=['--quiet'];
    if(this.exePath)args.push('--exe',this.exePath);
    args.push('--log-dir',this.logDir);
    let child;
    try{child=this.launch(args);}
    catch(error){throw plain(`The LTF launcher could not start: ${error.message}`);}
    this.child=child;
    let output='';
    child?.stdout?.setEncoding?.('utf8');
    child?.stdout?.on?.('data',chunk=>{output+=chunk;if(output.length>65536)output=output.slice(-65536);});
    const code=await Promise.race([
      new Promise(resolve=>{
        if(!child||typeof child.once!=='function')return resolve(0);
        child.once('error',()=>resolve(-1));child.once('exit',value=>resolve(value??-1));
      }),
      new Promise(resolve=>{const timer=setTimeout(()=>resolve('timeout'),this.launcherTimeout);timer.unref?.();}),
    ]);
    if(code==='timeout'){
      const hint=await readLauncherHint(this.logDir,logOffset);
      throw plain(`The LTF launcher did not finish starting LTK Manager.${hint?` ${hint}`:''}`);
    }
    if(code===4){
      const hint=await readLauncherHint(this.logDir,logOffset);
      throw plain(`The LTF launcher could not inject into LTK Manager. Close any open LTK Manager and try again.${hint?` (${hint})`:''}`);
    }
    if(code===5)throw plain('LTK Manager is already open. Close it and try again.');
    if(code===6){
      const hint=await readLauncherHint(this.logDir,logOffset);
      throw plain(`LTK Manager exited before the LTF bridge could attach. Close any open LTK Manager and try again.${hint?` (${hint})`:''}`);
    }
    if(code!==0){
      const hint=await readLauncherHint(this.logDir,logOffset);
      const tail=hint||(output?output.trim().split(/\r?\n/).at(-1):'');
      throw plain(code===-1?'The LTF launcher could not start.':`The LTF launcher failed (exit ${code}).${tail?` ${tail}`:''}`);
    }
    const spawnedPid=Number(/LTK_MANAGER_PID=(\d+)/.exec(output)?.[1])||0;
    // The launcher always prints the manager it started. Without that pid nothing could tell this
    // manager from another program's, and the bridge token would go to whatever answered.
    if(!spawnedPid){
      await this.killAll().catch(()=>{});
      throw plain('The LTF launcher did not say which LTK Manager it started, so Friloverse did not connect. Close any open LTK Manager and try again.');
    }
    this.managerPid=spawnedPid;
    try{
      const found=await this.waitForBridge(before,{expectedPid:spawnedPid});
      // The token is sent only to a port that has already said it belongs to this manager.
      const probe=await this.probeHello(found.port);
      if(probe?.pid!==spawnedPid)throw plain('The LTF bridge answered from another LTK Manager. Close it and try again.');
      this.port=found.port;this.token=found.token;
      const hello=await this.request('hello',{},{timeout:20000});
      if(hello?.pid!==spawnedPid)throw plain('The LTF bridge answered from another LTK Manager. Close it and try again.');
      await this.waitForCdp();
      // The owner wants LTK's automatic background health check off. It never replaces the
      // real check: `check_mod_health` and the game's own overlay verification still run.
      await this.request('health_check_off',{},{timeout:10000}).catch(()=>{});
      this.linked=true;
    }catch(error){
      this.linked=false;this.port=0;this.token='';this.managerPid=0;
      await this.killSpawned(spawnedPid);
      throw error;
    }
  }
  async fileTimes(){
    const [port,tokenInfo,token]=await Promise.all([
      stat(this.portFile).then(info=>info.mtimeMs,()=>0),
      stat(this.tokenFile).then(info=>info.mtimeMs,()=>0),
      readFile(this.tokenFile,'utf8').then(text=>text.trim(),()=>''),
    ]);
    return {port,tokenTime:tokenInfo,token};
  }
  async probeHello(port){
    return new Promise(resolve=>{
      const socket=this.connect({host:'127.0.0.1',port});
      let buffer='',settled=false;
      const done=value=>{if(settled)return;settled=true;clearTimeout(timer);socket.destroy();resolve(value);};
      const timer=setTimeout(()=>done(null),1500);
      socket.setEncoding?.('utf8');
      socket.on('connect',()=>socket.write(`${JSON.stringify({cmd:'hello'})}\n`));
      socket.on('data',chunk=>{
        buffer+=chunk;
        const end=buffer.indexOf('\n');
        if(end<0)return;
        try{
          const reply=JSON.parse(buffer.slice(0,end));
          done(reply?.ok&&reply.service==='LTKBridge'?reply:null);
        }catch{done(null);}
      });
      socket.on('error',()=>done(null));
      socket.on('close',()=>done(null));
    });
  }
  async scanPort(expectedPid){
    const probes=[];
    for(let port=PORT_MIN;port<=PORT_MAX;port++)probes.push(this.probeHello(port).then(hello=>hello?{port,hello}:null));
    const found=(await Promise.all(probes)).filter(Boolean);
    // Only the manager this launch started: a lone bridge of unknown origin is never taken.
    const exact=expectedPid?found.find(item=>item.hello.pid===expectedPid):null;
    return exact?exact.port:0;
  }
  async waitForBridge(before,{timeout=LAUNCH_TIMEOUT,expectedPid=0}={}){
    const deadline=this.now()+timeout;
    let last='',scans=0;
    while(this.now()<deadline){
      try{
        const [portTime,tokenTime,portRaw,tokenRaw,publicRaw]=await Promise.all([
          stat(this.portFile).then(info=>info.mtimeMs,()=>0),
          stat(this.tokenFile).then(info=>info.mtimeMs,()=>0),
          readFile(this.portFile,'utf8').then(text=>text.trim(),()=>''),
          readFile(this.tokenFile,'utf8').then(text=>text.trim(),()=>''),
          this.publicPortFile?readFile(this.publicPortFile,'utf8').then(text=>text.trim(),()=>''):Promise.resolve(''),
        ]);
        let port=Number(portRaw),token=tokenRaw;
        if(!validPort(port)&&publicRaw)port=Number(publicRaw);
        if(!validPort(port)||!validToken(token)){
          const reg=await this.readRegistry().catch(()=>({port:0,token:''}));
          if(!validPort(port)&&validPort(reg.port))port=reg.port;
          if(!validToken(token)&&validToken(reg.token))token=reg.token;
        }
        // BroadcastPort writes port.txt BEFORE token.txt: require token.txt to be updated
        // (new value, or rewritten at/after port.txt) so we never pair the new port with an old token.
        const tokenFresh=validToken(token)&&(token!==before.token||(tokenTime>before.tokenTime&&tokenTime>=portTime));
        if(validPort(port)&&tokenFresh)return {port,token};
        if(tokenFresh&&++scans%10===0){
          const scanned=await this.scanPort(expectedPid).catch(()=>0);
          if(validPort(scanned))return {port:scanned,token};
        }
        last='The LTF bridge files were not rewritten.';
      }catch(error){last=error.message;}
      await this.pause(PORT_POLL);
    }
    throw plain(`The LTF bridge did not answer. ${last}`.trim());
  }
  /** One request to the injected DLL, answered by one JSON line. */
  request(cmd,args={},{timeout=API_TIMEOUT}={}){
    return new Promise((resolve,reject)=>{
      if(!this.port||!this.token)return reject(plain('The LTF bridge is not connected.'));
      const port=this.port,token=this.token;
      const socket=this.connect({host:'127.0.0.1',port});
      let buffer='';let settled=false,opened=false;
      const finish=(error,value)=>{
        if(settled)return;settled=true;clearTimeout(timer);
        socket.destroy();
        if(error)reject(error);else resolve(value);
      };
      const timer=setTimeout(()=>finish(plain('The LTF bridge did not respond in time.')),timeout);
      socket.setEncoding?.('utf8');
      socket.on('connect',()=>{opened=true;socket.write(JSON.stringify({...args,cmd,token})+'\n');});
      socket.on('data',chunk=>{
        buffer+=chunk;
        const end=buffer.indexOf('\n');
        if(end<0)return;
        let reply;
        try{reply=JSON.parse(buffer.slice(0,end));}
        catch{return finish(plain('The LTF bridge sent an unreadable answer.'));}
        if(!reply||reply.ok!==true){
          const described=typeof reply?.error==='string'?reply.error:reply?.error?.message;
          const error=plain(described||'The LTF bridge refused the request.');
          if(reply?.error?.code)error.code=reply.error.code;
          return finish(error);
        }
        const response=reply.response;
        if(response&&response.ok===false)return finish(describeLtkError(response.error||{}));
        finish(null,reply);
      });
      socket.on('error',error=>{
        const failure=plain(`The LTF bridge could not be reached: ${error.message}`);
        // Nothing listens on the port: its manager is gone. A newer link is left as it is.
        if(!opened&&!settled){
          failure.unreachable=true;
          if(this.port===port&&this.token===token){this.linked=false;this.port=0;this.token='';}
        }
        finish(failure);
      });
      socket.on('close',()=>finish(plain('The LTF bridge closed without an answer.')));
    });
  }
  status(){return this.request('patcher_status',{},{timeout:10000}).then(valueOf);}
  async stop(){
    try{await this.request('stop_patcher',{},{timeout:30000});}
    catch(error){if(error.code!=='NOT_RUNNING'&&error.outerCode!=='PATCHER')throw error;if(error.code&&error.code!=='NOT_RUNNING'&&error.code!=='PATCHER')throw error;}
  }
  async waitPatcherStopped({timeout=this.stopTimeout,stale=()=>false}={}){
    const deadline=this.now()+timeout;
    while(this.now()<deadline){
      if(stale())return false;
      const current=await this.status().catch(()=>null);
      if(!this.connected||(!current?.running&&(!current?.phase||current.phase==='idle')))return true;
      await this.pause(PROCESS_POLL);
    }
    throw new Error('its patcher did not stop.');
  }
  async stopPatcher({timeout=this.stopTimeout,stale=()=>false}={}){
    if(!this.connected)return;
    const status=await this.status().catch(()=>null);
    // Its manager has gone, and its patcher with it; `ensure` starts another.
    if(!this.connected||(!status?.running&&(!status?.phase||status.phase==='idle')))return;
    await this.stop();
    await this.waitPatcherStopped({timeout,stale});
  }
  async patch({stale=()=>false,timeout=PATCH_TIMEOUT}={}){
    if(!this.connected)await this.ensure();
    const status=await this.status().catch(()=>null);
    if(!status?.running){
      try{await this.request('start_patcher',{},{timeout:60000});}
      catch(error){
        // Only retry when an earlier patcher stop/build is still winding down; surface real
        // errors like LEAGUE_ELEVATED, MANAGER_ELEVATED or DLL_UNAVAILABLE immediately.
        if(error.code!=='ALREADY_RUNNING')throw error;
        const stopped=await this.waitPatcherStopped({timeout:this.stopTimeout,stale});
        if(!stopped)return false;
        await this.request('start_patcher',{},{timeout:60000});
      }
    }
    const startedAt=this.now(),deadline=startedAt+timeout;
    let lastError=null;
    while(this.now()<deadline){
      if(stale())return false;
      try{
        const current=await this.status();
        // `building` means LTK is still making the overlay; only `patching` is scanning.
        if(current?.running&&current.phase==='patching')return true;
        if(current?.phase==='failed'||current?.phase==='error'){
          const detail=current?.error||current?.message||'';
          throw plain(`LTK Manager's patcher failed to start.${detail?` ${detail}`:''}`);
        }
        if(!current?.running&&(!current?.phase||current.phase==='idle')&&this.now()-startedAt>=this.idleGrace){
          throw plain('LTK Manager stopped its patcher before scanning began.');
        }
      }catch(error){
        if(error.plain&&/patcher failed|stopped its patcher/i.test(error.message))throw error;
        lastError=error;
      }
      await this.pause(150);
    }
    throw plain(`LTK Manager did not start its patcher.${lastError?` ${lastError.message}`:''}`.trim());
  }
  async endPatching(){if(this.connected)await this.stopPatcher();}
  async patcherAlive(){return this.hostRunning().catch(()=>false);}
  async readyMod(modId,{repair=true,timeout=IMPORT_TIMEOUT}={}){
    let verdict=valueOf(await this.request('check_mod_health',{modId},{timeout}));
    if(!verdict||verdict.modId!==undefined&&verdict.modId!==modId)throw plain('LTK Manager did not finish checking this skin. Choose it again to retry.');
    for(let pass=0;repair&&pass<3&&verdict?.fixable>0;pass++){
      await this.request('repair_mod',{modId},{timeout});
      const next=valueOf(await this.request('check_mod_health',{modId},{timeout}));
      if(!next)break;
      verdict=next;
    }
    const rules=verdict?.rules||[];
    if(rules.some(rule=>rule?.rule==='bin/skinhack'&&rule.severity!=='info'))return 'skinhack';
    if(rules.some(rule=>rule?.severity==='fatal')||verdict?.counts?.fatals>0||verdict?.health==='error')return 'damaged';
    return '';
  }
  async install(filePath){
    let reply;
    try{
      reply=await this.request('import',{path:filePath},{timeout:IMPORT_TIMEOUT});
    }catch(error){
      if(!IMPORT_UNREADABLE.test(String(error.message||'')))throw error;
      const info=await stat(filePath).catch(()=>null);
      if(!info?.isFile()||info.size<=0||info.size>INLINE_IMPORT_LIMIT)throw error;
      const bytes=await readFile(filePath);
      reply=await this.request('import',{name:path.basename(filePath),data_b64:bytes.toString('base64')},{timeout:IMPORT_TIMEOUT});
    }
    const value=valueOf(reply);
    if(!value?.mod?.id)throw new Error('LTK Manager did not report the installed skin.');
    // Preserve 'updated' distinctly from 'installed' so a user's own mod is never uninstalled!
    return {kind:value.kind||'installed',mod:value.mod};
  }
  async uninstall(modId){await this.request('uninstall',{target:modId},{timeout:30000});}
  async mods(){
    const reply=await this.request('list',{},{timeout:20000});
    const library=reply?.library??reply?.response?.library;
    if(!Array.isArray(library))throw new Error('LTK Manager did not answer with its library.');
    return library;
  }
  async toggle(modId,enabled){await this.request('toggle',{target:modId,enabled:!!enabled},{timeout:30000});}
  overlayMissing(champions,slots){return missingFromOverlay(champions,undefined,slots);}
  patcherAtStart(){return false;}
  async setPatcherAtStart(){}
  async closed(timeout=10000){
    const deadline=this.now()+timeout;
    while(await this.isRunning().catch(()=>false)||await this.hostRunning().catch(()=>false)){
      if(this.now()>=deadline)throw plain('LTK Manager did not close.');
      await this.pause(PROCESS_POLL);
    }
  }
  killAll(){
    const run=(file,args)=>Promise.resolve(this.taskkill(file,args,{windowsHide:true,timeout:5000})).catch(()=>{});
    return run('taskkill',['/F','/T','/IM',MANAGER]).then(()=>run('taskkill',['/F','/T','/IM',HOST]));
  }
  async quit(){
    if(this.connected)await this.request('kill',{},{timeout:5000}).catch(()=>{});
    await this.closed().catch(async()=>{
      if(this.managerPid)await this.killSpawned(this.managerPid);
      await this.closed(2000).catch(async()=>{await this.killAll();await this.closed().catch(()=>{});});
    });
    this.linked=false;this.port=0;this.token='';this.child=null;this.managerPid=0;
  }
  detach(){this.linked=false;this.child=null;}
}
