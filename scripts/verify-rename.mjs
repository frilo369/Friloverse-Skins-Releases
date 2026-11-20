// Test copies must not ask Windows for administrator rights (src/elevation.cjs).
process.env.FRILOVERSE_NO_ELEVATE='1';
// An old-named install moving to the new name, with real Squirrel on throwaway copies that cannot
// touch a real install: both names are test names, and LTK Manager is replaced by a stand-in.
//   updating itself: the old copy's feed offers the new package, and it installs under the new name
//   the setup: the new setup runs while the old copy is installed
// Each time the player's files must arrive, the new copy must run, and the old one must be gone.
// Uses Node 22+ and about 1 GB of temp space.
import {createServer} from 'node:http';
import {createReadStream,existsSync} from 'node:fs';
import {mkdir,readFile,readdir,rm,stat,writeFile} from 'node:fs/promises';
import {execFileSync,spawn,spawnSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import os from 'node:os';
import path from 'node:path';
import {packager} from '@electron/packager';
import installer from 'electron-winstaller';
import {noGameProcess} from '../src/lcu-safety.mjs';

// A shell that ran Electron as Node leaves ELECTRON_RUN_AS_NODE set: every test copy would
// start as plain Node instead of the app (start.mjs drops it for the same reason).
delete process.env.ELECTRON_RUN_AS_NODE;

const OLD={name:'oldnametest',exe:'OldNameTest'},NEW={name:'newnametest',exe:'NewNameTest'};
const work=path.join(os.tmpdir(),'fvr');
const local=process.env.LOCALAPPDATA,roaming=process.env.APPDATA;
const oldRoot=path.join(local,OLD.name),newRoot=path.join(local,NEW.name);
const oldData=path.join(roaming,OLD.name),newData=path.join(roaming,NEW.name);
const backupRoot=path.join(local,'FrYiLoCo','Riot Skins Converted');
const UNINSTALL='HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall';
const RUN_KEY='HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const moveLog=path.join(os.tmpdir(),`${NEW.name}-move.log`);
const replaceOnce=(text,from,to)=>{
  if(!text.includes(from))throw new Error(`The code changed, update this test: ${from.slice(0,70)}`);
  return text.replaceAll(from,to);
};

const LTK=`export const TESTED_VERSION='test';
export async function resolveLtkExecutable(){return 'stand-in';}
export const ltkRunning=async()=>false;
export const lastScanStart=async()=>0;
export class LtkBridge{
  constructor(){this.notice='';this.version='test';this.child=null;}
  get connected(){return false;}
  async ensure(){throw new Error('This test never starts LTK Manager.');}
  async quit(){}
  detach(){}
}
`;
async function patchCopy(buildPath,version,port,{name,exe,oldName,feed}){
  const edit=async(file,change)=>{const full=path.join(buildPath,file);await writeFile(full,change(await readFile(full,'utf8')));};
  await edit('package.json',text=>{const data=JSON.parse(text);data.name=name;data.version=version;return JSON.stringify(data,null,2);});
  await writeFile(path.join(buildPath,'src','ltk.mjs'),LTK);
  // The bundled bridge would start the real launcher from a test copy; the replaced LTK
  // stand-in above is the bridge this run uses.
  await writeFile(path.join(buildPath,'src','ltf-bridge.mjs'),`export async function ltfAvailable(){return false;}
export class LtfBridge{constructor(){this.notice='';this.child=null;}
get connected(){return false;}
async ensure(){throw new Error('This test never starts the bundled bridge.');}
async quit(){}
detach(){}}
`);
  await edit('src/ltk-preference.cjs',text=>replaceOnce(text,"path.join(env.APPDATA||'','dev.leaguetoolkit.manager','settings.json')",JSON.stringify(path.join(work,'ltk-settings.json'))));
  // Its server answers like the old feed, which reads fine for this: one full package.
  await edit('src/app-updater.mjs',text=>replaceOnce(text,"export const FEED='https://github.com/frilo369/Friloverse-Skins-Releases/releases/latest/download';",`export const FEED='${feed?`http://127.0.0.1:${port}/win32-x64/latest`:'http://127.0.0.1:9/none'}';`));
  // The real database folders stay out of this as well.
  for(const file of ['src/custom-database.mjs','src/riot-skins-local.mjs','src/skin-database.mjs'])
    await edit(file,text=>replaceOnce(text,"'friloverse-skins-data','Database'",`'${name}','Database'`));
  await edit('src/database-location.cjs',text=>replaceOnce(text,"const INSTALL='friloverse-skins',DATA='friloverse-skins-data';",`const INSTALL='${name}-legacy',DATA='${name}';`));
  await edit('src/custom-database.mjs',text=>replaceOnce(text,"const source=path.join(localAppData,'FrYiLoCo');",`const source=${JSON.stringify(path.join(work,'legacy'))};`));
  // The old copy has nothing older behind it, and the old program's name is its own.
  const older=oldName===OLD.name?OLD.exe:'NoOlderProgram';
  await edit('src/old-name.cjs',text=>{
    let code=replaceOnce(text,"const OLD={folder:'divinity',exe:'Divinity.exe',login:'Divinity',shortcut:'Divinity.lnk',backup:'Divinity'};",`const OLD={folder:'${oldName}',exe:'${older}.exe',login:'${older}',shortcut:'${older}.lnk',backup:'${older}'};`);
    return replaceOnce(code,"const NEW={folder:'friloverse-skins',exe:'Friloverse-Skins.exe',backup:'Friloverse'};",`const NEW={folder:'${NEW.name}',exe:'${NEW.exe}.exe',backup:'${NEW.exe}'};`);
  });
  await edit('src/main.cjs',text=>{
    let main=text.replaceAll('\r\n','\n');
    main=replaceOnce(main,"{name:'Friloverse Skins',openAtLogin:false}",`{name:'${exe}',openAtLogin:false}`);
    main=replaceOnce(main,'function configureLogin(){\n','function configureLogin(){\n  return;\n');
    main=replaceOnce(main,"app.setAppUserModelId('com.squirrel.friloverse-skins.Friloverse-Skins');",`app.setAppUserModelId('com.squirrel.${name}.${exe}');`);
    main=replaceOnce(main,"const preview = process.argv.includes('--preview');\n",`const preview = process.argv.includes('--preview');
const report=message=>{try{require('node:fs').appendFileSync(path.join(app.getPath('userData'),'test.log'),app.getVersion()+' '+process.pid+' '+message+'\\n');}catch{}};
`);
    main=replaceOnce(main,"if(!preview)dialog.showErrorBox('Friloverse could not start',String(error.message||error));",'report("FAILED "+error.stack);');
    main=replaceOnce(main,'onStatus:message=>{appTask(message,','onStatus:message=>{report("status "+message);appTask(message,');
    main=replaceOnce(main,'  if(preview||!startup)showDashboard();\n',`  if(preview||!startup)showDashboard();
  setTimeout(()=>report("running visible="+dashboard.isVisible()),3000);
`);
    return main;
  });
}

async function build(label,version,port,options){
  const out=path.join(work,label);
  const [directory]=await packager({dir:'.',name:options.exe,platform:'win32',arch:'x64',out,overwrite:true,prune:true,asar:false,appVersion:version,buildVersion:version,
    icon:'src/ui/friloverse.ico',win32metadata:{CompanyName:'FrYiLo',ProductName:options.exe},
    afterCopy:[async({buildPath})=>patchCopy(buildPath,version,port,options)],
    ignore:[/^\/(?:AGENTS|CLAUDE|CODEX-HANDOFF)\.md$/,/^\/\.gitignore$/,/^\/\.claude(?:\/|$)/,/^\/\.wrangler(?:\/|$)/,/\.log$/i,/^\/dist(?:\/|$)/,/^\/artifacts(?:\/|$)/,/^\/tests(?:\/|$)/,/^\/scripts(?:\/|$)/,/^\/tools(?:\/|$)/,/^\/\.git(?:\/|$)/,/^\/logs-worker(?:\/|$)/,/^\/watch-logs(?:\/|$)/,/^\/logs-reports(?:\/|$)/,/^\/native\/ltf\/.*\.cpp$/]});
  const outputDirectory=path.join(out,'setup');
  await installer.createWindowsInstaller({appDirectory:directory,outputDirectory,authors:'FrYiLo',exe:`${options.exe}.exe`,setupExe:'Setup.exe',setupIcon:'src/ui/friloverse.ico',noMsi:true});
  console.log(`Built ${label}.`);
  return outputDirectory;
}

let offered='';
const server=createServer(async(request,response)=>{
  const url=new URL(request.url,'http://127.0.0.1');
  try{
    if(url.pathname.endsWith('/RELEASES')){
      const body=(await readFile(path.join(offered,'RELEASES'),'utf8')).replace(/^\uFEFF/,'');
      response.writeHead(200,{'Content-Type':'text/plain'});
      response.end(body.replace(/(\S+\.nupkg)/,`http://127.0.0.1:${server.address().port}/package/$1`));
      return;
    }
    const file=path.join(offered,path.basename(url.pathname));
    const {size}=await stat(file);
    response.writeHead(200,{'Content-Length':size,'Content-Type':'application/octet-stream'});
    createReadStream(file).pipe(response);
  }catch{response.writeHead(404);response.end();}
});

const running=root=>{
  const script=`Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -like '${root}\\*' } | ForEach-Object { $_.ProcessId.ToString()+'|'+$_.ExecutablePath }`;
  return execFileSync('powershell',['-NoProfile','-Command',script],{encoding:'utf8',windowsHide:true}).trim().split(/\r?\n/).filter(Boolean).map(line=>{const [pid,file]=line.split('|');return {pid,file};});
};
const stop=root=>{for(const {pid} of running(root))spawnSync('taskkill',['/F','/PID',pid],{windowsHide:true});};
const registered=name=>spawnSync('reg',['query',`${UNINSTALL}\\${name}`],{windowsHide:true,stdio:'ignore'}).status===0;
const newLog=async()=>(await readFile(path.join(newData,'test.log'),'utf8').catch(()=>''));
async function until(check,label,ms=240000){
  const end=Date.now()+ms;
  while(Date.now()<end){const value=await check();if(value)return value;await delay(1000);}
  const tail=async file=>(await readFile(file,'utf8').catch(()=>'(none)')).split(/\r?\n/).slice(-30).join('\n');
  const logs=[await tail(moveLog),await tail(path.join(oldData,'test.log')),await newLog(),await tail(path.join(oldRoot,'SquirrelSetup.log')),await tail(path.join(oldRoot,'Squirrel-Update.log')),execFileSync('cmd',['/c','dir','/b',oldRoot,path.join(oldRoot,'packages')],{encoding:'utf8'})].join('\n---\n');
  throw new Error(`Timed out: ${label}\n${logs}`);
}
const check=(ok,message)=>{if(!ok)throw new Error(message);};
const startMenuFolder=path.join(roaming,'Microsoft','Windows','Start Menu','Programs','FrYiLo');
const shortcut=(folder,name)=>path.join(folder,`${name}.lnk`);
const desktop=path.join(os.homedir(),'Desktop');

async function cleanUp(){
  for(const [root,name] of [[oldRoot,OLD],[newRoot,NEW]]){
    stop(root);
    const update=path.join(root,'Update.exe');
    if(existsSync(update)){spawnSync(update,['--uninstall','-s'],{windowsHide:true,timeout:60000});await delay(2000);}
    stop(root);
    await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:1000}).catch(()=>{});
    spawnSync('reg',['delete',`${UNINSTALL}\\${name.name}`,'/f'],{windowsHide:true,stdio:'ignore'});
    await rm(shortcut(startMenuFolder,name.exe),{force:true});
    await rm(shortcut(desktop,name.exe),{force:true});
  }
  for(const folder of [oldData,newData,path.join(backupRoot,OLD.exe),path.join(backupRoot,NEW.exe)])await rm(folder,{recursive:true,force:true,maxRetries:5,retryDelay:1000}).catch(()=>{});
  await rm(moveLog,{force:true});
  await rm(path.join(local,`${NEW.name}-move`),{recursive:true,force:true}).catch(()=>{});
}

async function installOld(setup){
  execFileSync(path.join(setup,'Setup.exe'),['--silent'],{windowsHide:true});
  await until(()=>existsSync(path.join(oldRoot,'app-1.0.0',`${OLD.exe}.exe`)),'the old copy to install');
  await mkdir(path.join(oldRoot,'Database','Custom Skins','Ahri'),{recursive:true});
  await writeFile(path.join(oldRoot,'Database','Custom Skins','Ahri','mine.fantome'),'my skin');
  await mkdir(oldData,{recursive:true});
  await writeFile(path.join(oldData,'settings.json'),JSON.stringify({startWithWindows:false,autoAppUpdates:true,guideHotkey:'F24'}));
  await writeFile(path.join(oldData,'party-profile.json'),'{"name":"Mine"}');
  await mkdir(path.join(backupRoot,OLD.exe),{recursive:true});
  await writeFile(path.join(backupRoot,OLD.exe,'riot-skins-manifest.json'),'{}');
}

async function assertMoved(){
  await until(async()=>/running visible=/.test(await newLog()),'the new copy to run',120000);
  check(await readFile(path.join(newRoot,'Database','Custom Skins','Ahri','mine.fantome'),'utf8')==='my skin','The custom skin did not arrive.');
  check(await readFile(path.join(newData,'party-profile.json'),'utf8')==='{"name":"Mine"}','The party profile did not arrive.');
  check(JSON.parse(await readFile(path.join(newData,'settings.json'),'utf8')).guideHotkey==='F24','The settings did not arrive.');
  check(existsSync(path.join(backupRoot,NEW.exe,'riot-skins-manifest.json')),'The offline backup did not arrive.');
  await until(()=>!registered(OLD.name),'the old copy to leave Windows\' list of programs');
  await until(()=>!existsSync(oldRoot)&&!existsSync(oldData),'the old install and data folders to go',60000);
  check(registered(NEW.name),'The new copy is not in Windows\' list of programs.');
  const shortcuts=async()=>[...await readdir(startMenuFolder).catch(()=>[]),...(await readdir(desktop)).filter(file=>/test/i.test(file))].join(', ');
  const shortcutLog=await readFile(path.join(newRoot,'Squirrel-Shortcut.log'),'utf8').catch(()=>'(no log)');
  check(existsSync(shortcut(startMenuFolder,NEW.exe)),`The new Start menu shortcut is missing. There are: ${await shortcuts()}\n${shortcutLog}`);
  check(!existsSync(shortcut(startMenuFolder,OLD.exe)),'The old Start menu shortcut is still there.');
  check(!existsSync(shortcut(desktop,OLD.exe)),'The old desktop shortcut is still there.');
  check(existsSync(shortcut(desktop,NEW.exe)),'The new desktop shortcut is missing.');
  check((await newLog()).includes('running visible=false'),'The moved copy must start in the tray.');
  check(running(oldRoot).length===0,'Something of the old copy is still running.');
}

if(!await noGameProcess())throw new Error('A League game is running. Run this outside a match.');
const runBefore=execFileSync('reg',['query',RUN_KEY],{encoding:'utf8',windowsHide:true});
await cleanUp();
await rm(work,{recursive:true,force:true});await mkdir(work,{recursive:true});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const {port}=server.address();
let failed=false;
try{
  const oldSetup=await build('old','1.0.0',port,{name:OLD.name,exe:OLD.exe,oldName:'no-older-install',feed:true});
  const newSetup=await build('new','1.0.1',port,{name:NEW.name,exe:NEW.exe,oldName:OLD.name,feed:false});
  await writeFile(path.join(work,'ltk-settings.json'),'{}');

  await installOld(oldSetup);
  offered=newSetup;
  spawn(path.join(oldRoot,`${OLD.exe}.exe`),['--startup'],{detached:true,stdio:'ignore'}).unref();
  await assertMoved();
  console.log('Passed: an old copy updated itself and arrived under the new name, with the player\'s files.');

  await cleanUp();
  await installOld(oldSetup);
  offered=path.join(work,'nothing');
  spawn(path.join(oldRoot,`${OLD.exe}.exe`),['--startup'],{detached:true,stdio:'ignore'}).unref();
  await until(()=>running(oldRoot).length>0,'the old copy to run',60000);
  execFileSync(path.join(newSetup,'Setup.exe'),['--silent'],{windowsHide:true});
  await until(()=>existsSync(path.join(newRoot,`${NEW.exe}.exe`)),'the new copy to install');
  spawn(path.join(newRoot,`${NEW.exe}.exe`),['--startup'],{detached:true,stdio:'ignore'}).unref();
  await assertMoved();
  console.log('Passed: the new setup replaced a running old copy, with the player\'s files.');
}catch(error){failed=true;console.error(`FAILED: ${error.message}`);}
finally{
  await cleanUp();
  server.close();server.closeAllConnections();
  const runAfter=execFileSync('reg',['query',RUN_KEY],{encoding:'utf8',windowsHide:true});
  if(runAfter!==runBefore){failed=true;console.error('FAILED: the Windows startup list changed.');}
  await rm(work,{recursive:true,force:true}).catch(()=>{});
}
process.exit(failed?1:0);
