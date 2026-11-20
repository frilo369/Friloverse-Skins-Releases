// Divinity became Friloverse in 4.0: a new program name, install folder, data folders and Squirrel
// package. Nobody should have to do anything about that, so this moves an existing install across:
//  - An old copy that updates itself unpacks the new version inside its old folder, where it can
//    not run: Squirrel looks for the old program name. Squirrel's update event is the one moment
//    the new code runs there, so it installs itself properly from the package just downloaded.
//  - The first normal start in the new folder, whichever way it got there (that, or the setup),
//    closes the old program, moves the player's data and skins, and uninstalls the old copy.
// Every step can run again at the next start. The old install is only removed once nothing is
// left in it to lose, as Squirrel's uninstall deletes the whole folder, Database included.
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {createHash}=require('node:crypto');
const {spawn,spawnSync}=require('node:child_process');

const OLD={folder:'divinity',exe:'Divinity.exe',login:'Divinity',shortcut:'Divinity.lnk',backup:'Divinity'};
const NEW={folder:'friloverse-skins',exe:'Friloverse-Skins.exe',backup:'Friloverse'};

const pause=ms=>Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,ms);
// Squirrel installs beside the folder its Update.exe runs from, so this has to sit in LocalAppData.
const moveTemp=(env=process.env)=>path.join(env.LOCALAPPDATA,`${NEW.folder}-move`);
// What happened to a copy that passed through, for when a player reports one that did not arrive.
const note=message=>{try{fs.appendFileSync(path.join(os.tmpdir(),`${NEW.folder}-move.log`),`${new Date().toISOString()} ${message}\n`);}catch{}};

function insideOldInstall(execPath){
  return path.basename(path.resolve(path.dirname(execPath),'..')).toLowerCase()===OLD.folder;
}

function rename(from,to){
  for(let tries=0;;tries++){
    try{fs.renameSync(from,to);return true;}
    catch(error){
      if(tries>=10){console.error(`Could not move ${from}: ${error.message}`);return false;}
      pause(200); // The closed program's files can stay locked for a moment.
    }
  }
}

/** Moves what the target lacks and returns how many could not be moved. The target's copy wins. */
function moveMissing(from,to,skip=new Set()){
  if(!fs.existsSync(to)){
    fs.mkdirSync(path.dirname(to),{recursive:true});
    if(!skip.size)return rename(from,to)?0:1;
    fs.mkdirSync(to);
  }
  let failed=0;
  for(const entry of fs.readdirSync(from,{withFileTypes:true})){
    if(skip.has(entry.name))continue;
    const source=path.join(from,entry.name),target=path.join(to,entry.name);
    if(!fs.existsSync(target))failed+=rename(source,target)?0:1;
    else if(entry.isDirectory()&&fs.statSync(target).isDirectory())failed+=moveMissing(source,target);
  }
  return failed;
}

function closeOldProgram(){
  // By name only, no process tree: the new copy can be a far descendant of the old one.
  const {status}=spawnSync('taskkill',['/F','/IM',OLD.exe],{windowsHide:true,stdio:'ignore',timeout:15000});
  if(status===0)pause(500);
}

function uninstallOldCopy(root){
  const update=path.join(root,'Update.exe');
  if(fs.existsSync(update)&&!fs.existsSync(path.join(root,'.dead'))){
    spawn(update,['--uninstall','-s'],{detached:true,stdio:'ignore',windowsHide:true}).unref();
    return;
  }
  // Squirrel leaves this when it could not delete everything at the time.
  fs.rmSync(root,{recursive:true,force:true});
}

/**
 * At a normal start in the new folder. Returns true if an old install was found, so the caller can
 * take its entry off the Windows startup list.
 */
function moveOldInstall({env=process.env,desktop,closeOld=closeOldProgram,uninstall=uninstallOldCopy}={}){
  const local=env.LOCALAPPDATA,roaming=env.APPDATA;
  if(!local||!roaming)return false;
  const root=path.join(local,OLD.folder);
  const moves=[
    [path.join(roaming,OLD.folder),path.join(roaming,NEW.folder),new Set(['lockfile'])],
    [path.join(root,'Database'),path.join(local,NEW.folder,'Database')],
    [path.join(local,'FrYiLoCo','Riot Skins Converted',OLD.backup),path.join(local,'FrYiLoCo','Riot Skins Converted',NEW.backup)]
  ];
  if(!fs.existsSync(root)&&!moves.some(([from])=>fs.existsSync(from)))return false;
  closeOld();
  let failed=0;
  for(const [from,to,skip] of moves){
    if(!fs.existsSync(from))continue;
    try{
      const left=moveMissing(from,to,skip);
      if(left)failed+=left;
      else fs.rmSync(from,{recursive:true,force:true,maxRetries:3,retryDelay:200});
    }catch(error){failed++;console.error(`Could not move ${from}: ${error.message}`);}
  }
  if(failed)return true; // Nothing is removed while anything is left to move. The next start tries again.
  const folders=[path.join(roaming,'Microsoft','Windows','Start Menu','Programs','FrYiLo'),desktop].filter(Boolean);
  for(const folder of folders)fs.rmSync(path.join(folder,OLD.shortcut),{force:true});
  fs.rmSync(moveTemp(env),{recursive:true,force:true,maxRetries:2,retryDelay:200});
  if(fs.existsSync(root))uninstall(root);
  return true;
}

/** What Squirrel's own setup does, from the package an old copy has just downloaded. */
function prepareInstall({root,version,temp=moveTemp()}){
  const name=`${NEW.folder}-${version}-full.nupkg`,nupkg=path.join(root,'packages',name);
  fs.rmSync(temp,{recursive:true,force:true});
  fs.mkdirSync(temp,{recursive:true});
  fs.copyFileSync(path.join(root,'Update.exe'),path.join(temp,'Update.exe'));
  fs.copyFileSync(nupkg,path.join(temp,name));
  const data=fs.readFileSync(nupkg),sha=createHash('sha1').update(data).digest('hex').toUpperCase();
  fs.writeFileSync(path.join(temp,'RELEASES'),`${sha} ${name} ${data.length}`);
  return temp;
}

/** The new version running inside the old folder. It only ever passes through. */
function oldInstallEvent(app,{execPath=process.execPath,env=process.env}={}){
  try{
    note(`passing through: ${process.argv.slice(1).join(' ')}`);
    if(process.argv.includes('--squirrel-updated')){
      const temp=prepareInstall({root:path.resolve(path.dirname(execPath),'..'),version:app.getVersion()});
      // Squirrel only waits a few seconds for this event, and installing takes longer.
      spawn(execPath,[path.join(__dirname,'old-name-install.cjs'),temp],{detached:true,stdio:'ignore',windowsHide:true,env:{...env,ELECTRON_RUN_AS_NODE:'1'}}).unref();
    }else if(!process.argv.some(arg=>arg.startsWith('--squirrel-'))){
      const moved=path.join(env.LOCALAPPDATA||'',NEW.folder,NEW.exe);
      if(fs.existsSync(moved))spawn(moved,process.argv.slice(1),{detached:true,stdio:'ignore'}).unref();
    }
  }catch(error){note(`could not leave the old install: ${error.message}`);}
  app.quit();
}

/**
 * Squirrel marks a folder dead when something in it was still in use, and leaves that for later.
 * Uninstalling also starts the old program for a moment, which makes itself a new, empty data folder.
 * The uninstall only begins once everything has moved, so nothing of the player's can be in either.
 */
function finishOldInstall(env=process.env){
  const root=path.join(env.LOCALAPPDATA,OLD.folder);
  if(fs.existsSync(root)&&!fs.existsSync(path.join(root,'.dead')))return;
  for(const folder of [root,path.join(env.APPDATA,OLD.folder)])fs.rmSync(folder,{recursive:true,force:true,maxRetries:3,retryDelay:500});
}

const forgetOldLogin=app=>app.setLoginItemSettings({name:OLD.login,openAtLogin:false});

module.exports={OLD,NEW,insideOldInstall,moveOldInstall,prepareInstall,oldInstallEvent,finishOldInstall,forgetOldLogin};
