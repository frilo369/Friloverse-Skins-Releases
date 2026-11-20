// Test copies must not ask Windows for administrator rights (src/elevation.cjs).
process.env.FRILOVERSE_NO_ELEVATE='1';
// A real update, start to finish, on a throwaway copy that cannot touch the real install:
// it has its own name, folders and login entry, and LTK Manager is replaced by a stand-in.
// Everything else is the real thing: main.cjs, the updater, Squirrel, the guard, quitting.
//   1.0.0 -> 1.0.1  automatic, from the tray, with an old saved "off": comes back hidden, then finds nothing new
//   1.0.1 -> 1.0.2  "Check for updates", window open: comes back on screen
//   1.0.2 -> 1.0.3  automatic, window open but not in use: comes back open, without focus
//   1.0.3 -> 1.0.4  "Check for updates", window closed meanwhile: opens on screen
//   1.0.4 -> broken package: stays on 1.0.4 and keeps running
// Every update is a delta, from a server that answers like GitHub's newest release, and the 1.0.4
// delta arrives damaged, so Squirrel must fall back to the full package.
// Uses Node 22+ and about 1 GB of temp space. Opens a test window for a moment.
import {createServer} from 'node:http';
import {existsSync} from 'node:fs';
import {mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import {execFileSync,spawn,spawnSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import os from 'node:os';
import path from 'node:path';
import {packager} from '@electron/packager';
import installer from 'electron-winstaller';
import {noGameProcess} from '../src/lcu-safety.mjs';
import {processRunning} from '../src/process-list.mjs';
import {finishReleases,keepAppVersion,parseReleases,prepareDelta,previousBuild} from './release-feed.mjs';

// A shell that ran Electron as Node leaves ELECTRON_RUN_AS_NODE set: every test copy would
// start as plain Node instead of the app (start.mjs drops it for the same reason).
delete process.env.ELECTRON_RUN_AS_NODE;

const NAME='friloverseupdatetest',EXE='FriloverseUpdateTest';
const work=path.join(os.tmpdir(),'fvu');
const installRoot=path.join(process.env.LOCALAPPDATA,NAME),dataRoot=path.join(process.env.APPDATA,NAME);
const stubExe=path.join(installRoot,`${EXE}.exe`),logFile=path.join(dataRoot,'update-test.log');
const ltkSettings=path.join(work,'ltk-settings.json');
const LTK_OTHERS={leaguePath:'D:/League',alwaysStartPatcher:true,accentColor:{preset:'gold',customHue:7},trustedDomains:['a','b']};
const readLtk=async()=>JSON.parse(await readFile(ltkSettings,'utf8'));
const preferenceSet=async()=>{const {enforceSkinhackScan,...others}=await readLtk().catch(()=>({}));return enforceSkinhackScan===false&&JSON.stringify(others)===JSON.stringify(LTK_OTHERS);};
const RUN_KEY='HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const replaceOnce=(text,from,to)=>{
  if(!text.includes(from))throw new Error(`main code changed, update this test: ${from.slice(0,70)}`);
  return text.replaceAll(from,to);
};

// The stand-ins. The bridge reports an idle client and an empty library.
const LTK=`export const TESTED_VERSION='test';
export async function resolveLtkExecutable(){return 'stand-in';}
export const ltkRunning=async()=>false;
export const lastScanStart=async()=>0;
export class LtkBridge{
  constructor(){this.notice='';this.version='test';this.child=null;}
  get connected(){return false;}
  async ensure(){throw new Error('The update test never starts LTK Manager.');}
  async quit(){}
  detach(){}
}
`;
async function patchCopy(buildPath,version,port){
  const edit=async(file,change)=>{const full=path.join(buildPath,file);await writeFile(full,change(await readFile(full,'utf8')));};
  await edit('package.json',text=>{const data=JSON.parse(text);data.name=NAME;data.version=version;delete data.productName;return JSON.stringify(data,null,2);});
  await writeFile(path.join(buildPath,'src','ltk.mjs'),LTK);
  // The bundled bridge would start the real launcher from a test copy; the replaced LTK
  // stand-in above is the bridge this run uses.
  await writeFile(path.join(buildPath,'src','ltf-bridge.mjs'),`export async function ltfAvailable(){return false;}
export class LtfBridge{constructor(){this.notice='';this.child=null;}
get connected(){return false;}
async ensure(){throw new Error('The update test never starts the bundled bridge.');}
async quit(){}
detach(){}}
`);
  // Never let a test copy notice or move the owner's old install.
  await edit('src/old-name.cjs',text=>replaceOnce(text,"const OLD={folder:'divinity',exe:'Divinity.exe',login:'Divinity',shortcut:'Divinity.lnk',backup:'Divinity'};","const OLD={folder:'no-old-install',exe:'NoOldProgram.exe',login:'NoOldProgram',shortcut:'NoOldProgram.lnk',backup:'NoOldProgram'};"));
  // And the real database folders.
  for(const file of ['src/custom-database.mjs','src/riot-skins-local.mjs','src/skin-database.mjs'])
    await edit(file,text=>replaceOnce(text,"'friloverse-skins-data','Database'",`'${NAME}','Database'`));
  await edit('src/database-location.cjs',text=>replaceOnce(text,"const INSTALL='friloverse-skins',DATA='friloverse-skins-data';",`const INSTALL='${NAME}-legacy',DATA='${NAME}';`));
  await edit('src/custom-database.mjs',text=>replaceOnce(text,"const source=path.join(localAppData,'FrYiLoCo');",`const source=${JSON.stringify(path.join(work,'legacy'))};`));
  // LTK Manager's real settings stay out of this: a test copy of its file takes their place.
  await edit('src/ltk-preference.cjs',text=>replaceOnce(text,"path.join(env.APPDATA||'','dev.leaguetoolkit.manager','settings.json')",JSON.stringify(ltkSettings)));
  const feed=`http://127.0.0.1:${port}/latest/download`;
  await edit('src/app-updater.mjs',text=>replaceOnce(text,"export const FEED='https://github.com/frilo369/Friloverse-Skins-Releases/releases/latest/download';",`export const FEED='${feed}';`));
  await edit('src/main.cjs',text=>{
    let main=text.replaceAll('\r\n','\n');
    // The real Run entry and taskbar identity must stay out of this.
    main=replaceOnce(main,"{name:'Friloverse Skins',openAtLogin:false}",`{name:'${EXE}',openAtLogin:false}`);
    main=replaceOnce(main,'function configureLogin(){\n','function configureLogin(){\n  return;\n');
    main=replaceOnce(main,"app.setAppUserModelId('com.squirrel.friloverse-skins.Friloverse-Skins');",`app.setAppUserModelId('com.squirrel.${NAME}.${EXE}');`);
    // Report what happens, and let the test press Check for updates. The test calls the
    // updater directly: the real button also runs the collection check, on the real folder.
    main=replaceOnce(main,"const preview = process.argv.includes('--preview');\n",`const preview = process.argv.includes('--preview');
const report=message=>{try{require('node:fs').appendFileSync(path.join(app.getPath('userData'),'update-test.log'),app.getVersion()+' '+process.pid+' '+message+'\\n');}catch{}};
`);
    main=replaceOnce(main,'onStatus:message=>{appTask(message,','onStatus:message=>{report("status "+message);appTask(message,');
    main=replaceOnce(main,'  if(preview||!startup)showDashboard();\n',`  if(preview||!startup)showDashboard();
  setTimeout(()=>report("running args="+process.argv.slice(1).join(",")+" focused="+dashboard.isFocused()+" visible="+dashboard.isVisible()),3000);
  if(process.argv.includes('--test-check'))setTimeout(()=>appUpdater.check({manual:true}),6000);
  if(process.argv.includes('--test-blur'))setTimeout(()=>dashboard.blur(),2000);
  if(process.argv.includes('--test-hide'))setTimeout(()=>dashboard.hide(),2000);
`);
    main=replaceOnce(main,"app.on('second-instance', (_event,args) => {\n","app.on('second-instance', (_event,args) => {\n  report('second-instance '+args.slice(1).join(','));\n");
    return main;
  });
}

async function build(version,port){
  const out=path.join(work,version);
  // As build.mjs: the exe carries Electron's version, so it is the same file in every version.
  const {version:electronVersion}=JSON.parse(await readFile('node_modules/electron/package.json','utf8'));
  const [directory]=await packager({dir:'.',name:EXE,platform:'win32',arch:'x64',out,overwrite:true,prune:true,asar:false,appVersion:electronVersion,buildVersion:electronVersion,
    icon:'src/ui/friloverse.ico',
    afterCopy:[async({buildPath})=>patchCopy(buildPath,version,port)],afterInitialize:[keepAppVersion(version)],
    ignore:[/^\/(?:AGENTS|CLAUDE|CODEX-HANDOFF)\.md$/,/^\/\.gitignore$/,/^\/\.claude(?:\/|$)/,/^\/\.wrangler(?:\/|$)/,/\.log$/i,/^\/dist(?:\/|$)/,/^\/artifacts(?:\/|$)/,/^\/tests(?:\/|$)/,/^\/scripts(?:\/|$)/,/^\/tools(?:\/|$)/,/^\/native(?:\/|$)/,/^\/\.git(?:\/|$)/,/^\/logs-worker(?:\/|$)/,/^\/watch-logs(?:\/|$)/,/^\/logs-reports(?:\/|$)/]});
  const outputDirectory=path.join(out,'setup');
  // Packed as build.mjs packs a release: a delta from the version before, deltas by address.
  const previous=await previousBuild(work,version);
  await mkdir(outputDirectory,{recursive:true});await prepareDelta(outputDirectory,previous);
  await installer.createWindowsInstaller({appDirectory:directory,outputDirectory,authors:'FrYiLo',exe:`${EXE}.exe`,setupExe:'Setup.exe',setupIcon:'src/ui/friloverse.ico',noMsi:true});
  const {full,delta}=await finishReleases(outputDirectory,version,{previous,assetUrl:(from,name)=>`http://127.0.0.1:${port}/download/v${from}/${name}`});
  console.log(`Built ${version}: full ${(full.size/1048576).toFixed(1)} MB${delta?`, delta ${(delta.size/1048576).toFixed(2)} MB`:''}.`);
  return outputDirectory;
}

// Answers like GitHub: /latest/download/<file> is the offered release's file, /download/v<x>/<file>
// release x's, both through a redirect as GitHub's are. A file is served from
// work/<version>/setup, the folder build() packed it into, whatever version asked.
let offered='';const requests=[],damaged=new Set();
const server=createServer(async(request,response)=>{
  const url=new URL(request.url,'http://127.0.0.1');
  requests.push(url.pathname+url.search);
  const {port}=server.address(),release=path.basename(path.dirname(offered));
  try{
    const parts=url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    if(parts.at(-1)==='RELEASES'){
      const body=(await readFile(path.join(offered,'RELEASES'),'utf8')).replace(/^\uFEFF/,'');
      response.writeHead(200,{'Content-Type':'text/plain'});response.end(body);
      return;
    }
    if(parts[0]==='latest'&&parts[1]==='download'){response.writeHead(302,{Location:`/asset/${release}/${encodeURIComponent(parts[2])}`});response.end();return;}
    if(parts[0]==='download'&&/^v\d/.test(parts[1])){response.writeHead(302,{Location:`/asset/${parts[1].slice(1)}/${encodeURIComponent(parts[2])}`});response.end();return;}
    if(parts[0]!=='asset'||parts.length!==3)throw new Error('not found');
    const file=path.join(work,path.basename(parts[1]),'setup',path.basename(parts[2]));
    let data=await readFile(file);
    if(damaged.has(parts[2])){data=Buffer.from(data);data[data.length>>1]^=0xff;}
    response.writeHead(200,{'Content-Length':data.length,'Content-Type':'application/octet-stream'});response.end(data);
  }catch{response.writeHead(404);response.end();}
});
// Which packages a step downloaded: everything asked for since `from`.
const fetched=from=>requests.slice(from).filter(item=>item.startsWith('/asset/')).map(item=>decodeURIComponent(item.split('/').pop()));
const onlyDelta=async(from,version)=>{
  const got=fetched(from);
  await assert(got.length===1&&got[0]===`${NAME}-${version}-delta.nupkg`,`The update to ${version} should have downloaded only its delta: ${JSON.stringify(got)}`);
};

const processes=()=>{
  const script=`Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -like '${installRoot}\\*' } | ForEach-Object { $_.ProcessId.ToString()+'|'+$_.Name+'|'+$_.ExecutablePath }`;
  return execFileSync('powershell',['-NoProfile','-Command',script],{encoding:'utf8',windowsHide:true}).trim().split(/\r?\n/).filter(Boolean).map(line=>{const [pid,name,file]=line.split('|');return {pid,name,file};});
};
const stopCopy=()=>{for(const {pid} of processes())spawnSync('taskkill',['/F','/PID',pid],{windowsHide:true});};
const log=async()=>(await readFile(logFile,'utf8').catch(()=>'')).trim().split(/\r?\n/).filter(Boolean);
async function until(check,label,ms=240000){
  const end=Date.now()+ms;
  while(Date.now()<end){const value=await check();if(value)return value;await delay(1000);}
  throw new Error(`Timed out: ${label}\n${(await log()).slice(-12).join('\n')}`);
}
const logged=pattern=>until(async()=>(await log()).find(line=>pattern.test(line)),String(pattern));
const assert=async(ok,message)=>{if(!ok)throw new Error(`${message}\n${(await log()).slice(-12).join('\n')}`);};
const start=(...args)=>spawn(stubExe,args,{detached:true,stdio:'ignore'}).unref();
// Older versions had an off switch: a saved "off" must no longer stop anything.
const settings=()=>writeFile(path.join(dataRoot,'settings.json'),JSON.stringify({startWithWindows:false,autoAppUpdates:false,guideHotkey:'F24'}));
async function cleanUp(){
  stopCopy();
  const update=path.join(installRoot,'Update.exe');
  if(existsSync(update)){spawnSync(update,['--uninstall','-s'],{windowsHide:true,timeout:60000});await delay(3000);}
  stopCopy();
  await rm(installRoot,{recursive:true,force:true,maxRetries:5,retryDelay:1000}).catch(()=>{});
  await rm(dataRoot,{recursive:true,force:true,maxRetries:5,retryDelay:1000}).catch(()=>{});
  await rm(path.join(process.env.LOCALAPPDATA,'FrYiLoCo','Riot Skins Converted',EXE),{recursive:true,force:true}).catch(()=>{});
}

if(!await noGameProcess())throw new Error('A League game is running. Run this outside a match.');
if(await processRunning('ltk-manager.exe'))throw new Error('LTK Manager is open, so the copy would leave its settings alone. Close it first.');
const runBefore=execFileSync('reg',['query',RUN_KEY],{encoding:'utf8',windowsHide:true});
await cleanUp();
await rm(work,{recursive:true,force:true});await mkdir(work,{recursive:true});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const {port}=server.address();
let failed=false;
try{
  const [first,second,third,fourth,fifth]=[await build('1.0.0',port),await build('1.0.1',port),await build('1.0.2',port),await build('1.0.3',port),await build('1.0.4',port)];
  // The preference on a new install, with every other LTK Manager setting kept.
  await writeFile(ltkSettings,JSON.stringify({...LTK_OTHERS,enforceSkinhackScan:true}));
  // Smart App Control refuses each freshly built Setup.exe (event 3077, 2026-11-08): turn it off
  // for this test, or this line fails with spawnSync ... UNKNOWN.
  execFileSync(path.join(first,'Setup.exe'),['--silent'],{windowsHide:true});
  await until(()=>existsSync(path.join(installRoot,'app-1.0.0',`${EXE}.exe`)),'install');
  await until(preferenceSet,'the install to set enforceSkinhackScan to false',30000);
  console.log('Passed: a fresh install set enforceSkinhackScan to false and kept every other setting.');
  await mkdir(dataRoot,{recursive:true});

  // Automatic, from the tray.
  await settings();offered=second;
  let from=requests.length;
  start('--startup');
  await logged(/^1\.0\.0 \d+ running .*visible=false/);
  await logged(/^1\.0\.0 \d+ status App update downloaded/);
  const hidden=await logged(/^1\.0\.1 \d+ running .*visible=/);
  await assert(hidden.endsWith('visible=false'),'An automatic update must come back in the tray.');
  await logged(/^1\.0\.1 \d+ status Friloverse is up to date/);
  const afterFirst=processes();
  await assert(afterFirst.every(item=>item.file.includes('app-1.0.1')),`A process of the old version is still running: ${JSON.stringify(afterFirst)}`);
  console.log('Passed: automatic update from the tray came back hidden, on the new version, with nothing old left running.');
  await onlyDelta(from,'1.0.1');
  console.log('Passed: an automatic update downloaded only the delta.');

  // Check for updates, window open.
  stopCopy();await delay(1500);await settings();offered=third;
  // LTK Manager dropped the key when it saved its settings: only the update puts it back.
  await writeFile(ltkSettings,JSON.stringify(LTK_OTHERS));
  from=requests.length;
  start('--test-check');
  await logged(/^1\.0\.1 \d+ running .*visible=true/);
  await assert(!await preferenceSet(),'A version that has already applied the preference must not apply it again.');
  const shown=await logged(/^1\.0\.2 \d+ running .*visible=/);
  await assert(shown.endsWith('visible=true'),'An update the player asked for must come back on screen.');
  await assert(JSON.parse(await readFile(path.join(dataRoot,'settings.json'),'utf8')).guideHotkey==='F24','The update lost a setting.');
  await assert(await preferenceSet(),`The update did not set enforceSkinhackScan to false and keep the rest: ${await readFile(ltkSettings,'utf8')}`);
  console.log('Passed: an update set enforceSkinhackScan to false and kept every other setting.');
  console.log('Passed: Check for updates worked, and the window came back.');
  await onlyDelta(from,'1.0.2');
  console.log('Passed: a copy asking GitHub downloaded only the delta, through GitHub-style redirects.');

  // Automatic, window open but not in use: nothing to press, and the window stays open.
  stopCopy();await delay(1500);await settings();offered=fourth;
  start('--test-blur');
  await logged(/^1\.0\.2 \d+ running .*visible=true/);
  const quiet=await logged(/^1\.0\.3 \d+ running .*visible=/);
  await assert(quiet.endsWith('focused=false visible=true'),`An automatic update must bring an open window back without taking focus: ${quiet}`);
  console.log('Passed: an automatic update brought an open window back without taking focus.');

  // Check for updates, then the window is closed to the tray before the update is ready.
  // The 1.0.4 delta arrives damaged: Squirrel must notice and take the full package.
  stopCopy();await delay(1500);await settings();offered=fifth;
  damaged.add(`${NAME}-1.0.4-delta.nupkg`);from=requests.length;
  start('--test-check','--test-hide');
  await logged(/^1\.0\.3 \d+ running .*visible=false/);
  const reopened=await logged(/^1\.0\.4 \d+ running .*visible=/);
  await assert(reopened.endsWith('visible=true'),`An update the player asked for must open on screen: ${reopened}`);
  console.log('Passed: Check for updates opened the new version on screen, even with the window closed.');
  const fallback=fetched(from);
  await assert(fallback.includes(`${NAME}-1.0.4-delta.nupkg`)&&fallback.includes(`${NAME}-1.0.4-full.nupkg`),`A damaged delta should end in the full package: ${JSON.stringify(fallback)}`);
  console.log('Passed: a damaged delta fell back to the full package, and the update still went through.');

  // A damaged download.
  stopCopy();await delay(1500);await settings();
  const brokenFolder=path.join(work,'1.0.5','setup');await mkdir(brokenFolder,{recursive:true});
  // RELEASES now holds several lines: the full package is the first.
  const [{sha:hash,size}]=parseReleases(await readFile(path.join(fifth,'RELEASES'),'utf8'));
  await writeFile(path.join(brokenFolder,'RELEASES'),`${hash} ${NAME}-1.0.5-full.nupkg ${size}`);
  await writeFile(path.join(brokenFolder,`${NAME}-1.0.5-full.nupkg`),Buffer.alloc(Math.min(Number(size),1048576),7));
  offered=brokenFolder;
  const before=(await log()).length;
  start('--startup');
  await until(async()=>(await log()).slice(before).some(line=>/status Could not check for app updates/.test(line)),'the damaged update to be refused');
  await delay(3000);
  const left=processes();
  await assert(left.length&&left.every(item=>item.file.includes('app-1.0.4')),`A damaged update must leave the app running: ${JSON.stringify(left)}`);
  await assert(!existsSync(path.join(installRoot,'app-1.0.5')),'A damaged update must not be installed.');
  console.log('Passed: a damaged update was refused and the app kept running.');
  console.log(`The copy asked the feed ${requests.filter(item=>item.includes('RELEASES')).length} times and downloaded ${fetched(0).length} packages.`);
}catch(error){
  failed=true;console.error(`FAILED: ${error.message}`);
  console.error('LTK settings:',await readFile(ltkSettings,'utf8').catch(()=>'(missing)'));
  console.error('test processes:',JSON.stringify(processes()));
}
finally{
  await cleanUp();
  server.close();server.closeAllConnections();
  const runAfter=execFileSync('reg',['query',RUN_KEY],{encoding:'utf8',windowsHide:true});
  if(runAfter!==runBefore){failed=true;console.error('FAILED: the Windows startup list changed.');}
  await rm(work,{recursive:true,force:true}).catch(()=>{});
}
process.exit(failed?1:0);
