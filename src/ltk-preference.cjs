// The owner's standing preference for LTK Manager's settings file, applied after every
// install and update. Plain and synchronous: Squirrel's install and update events quit
// within moments. LTK Manager keeps its settings in memory and writes them back, so the
// file is only changed while it is closed; the next start of Friloverse tries again.
const fs=require('node:fs');
const path=require('node:path');
const {randomBytes}=require('node:crypto');

const PREFERENCE={enforceSkinhackScan:false};

const settingsPath=(env=process.env)=>path.join(env.APPDATA||'','dev.leaguetoolkit.manager','settings.json');
function ltkOpen(){
  try{return require('./windows-process.cjs').processNames().has('ltk-manager.exe');}
  catch{return true;} // Unknown: wait for the next start rather than lose the change.
}

/**
 * Returns what happened: 'set', 'already', 'missing' (LTK has no settings yet; they are
 * written with this preference by `prepareQuietStart`), 'unreadable' (never overwritten)
 * or 'open' (LTK Manager is running).
 */
function applyPreference(file=settingsPath(),{isOpen=ltkOpen}={}){
  let settings;
  try{settings=JSON.parse(fs.readFileSync(file,'utf8'));}
  catch(error){return error.code==='ENOENT'?'missing':'unreadable';}
  if(!settings||typeof settings!=='object'||Array.isArray(settings))return 'unreadable';
  if(Object.entries(PREFERENCE).every(([key,value])=>settings[key]===value))return 'already';
  if(isOpen())return 'open';
  const temp=`${file}.friloverse-${randomBytes(8).toString('hex')}.tmp`;
  try{
    fs.writeFileSync(temp,JSON.stringify({...settings,...PREFERENCE},null,2),{encoding:'utf8',flag:'wx'});
    if(isOpen())return 'open';
    fs.renameSync(temp,file);
  }finally{try{fs.unlinkSync(temp);}catch{/* Already moved into place. */}}
  return 'set';
}

/** Once for each installed version: a stamp beside Friloverse's own data says it is done. */
function applyForVersion(version,stampFile,options={}){
  let stamp='';
  try{stamp=fs.readFileSync(stampFile,'utf8').trim();}catch{/* Not done yet. */}
  if(stamp===version)return 'done';
  const result=applyPreference(options.file,options);
  if(['set','already','missing'].includes(result)){
    fs.mkdirSync(path.dirname(stampFile),{recursive:true});
    fs.writeFileSync(stampFile,version,'utf8');
  }
  return result;
}

module.exports={PREFERENCE,settingsPath,applyPreference,applyForVersion};
