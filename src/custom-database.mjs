import {constants} from 'node:fs';
import {copyFile, mkdir, readdir, lstat, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';

/**
 * Friloverse's custom libraries sit beside RiotSkins in its database. Existing FrYiLoCo files
 * are copied once; originals are never changed or removed.
 */
export const CUSTOM_SKINS='Custom Skins', CUSTOM_MODS='Custom Mods';
const LIBRARIES=[CUSTOM_SKINS,CUSTOM_MODS];
// How many starts an old file that could not be copied gets, before it is left where it is.
const MAX_IMPORT_TRIES=5;

export function localAppDataRoot(localAppData=process.env.LOCALAPPDATA||path.join(process.env.USERPROFILE||'','AppData','Local')){
  return localAppData;
}
export function friloverseDatabaseRoot(localAppData=localAppDataRoot()){
  return path.join(localAppData,'friloverse-skins-data','Database');
}
export function customSkinsRoot(localAppData=localAppDataRoot()){
  return path.join(friloverseDatabaseRoot(localAppData),CUSTOM_SKINS);
}
export function customModsRoot(localAppData=localAppDataRoot()){
  return path.join(friloverseDatabaseRoot(localAppData),CUSTOM_MODS);
}

async function walkFiles(root,onProblem=()=>{}){
  const files=[];
  const walk=async(dir)=>{
    let entries;
    // A folder that cannot be read costs what is in it, not the rest of the import.
    try{entries=await readdir(dir,{withFileTypes:true});}catch(error){if(error.code!=='ENOENT')onProblem(dir,error);return;}
    for(const entry of entries){
      if(entry.isSymbolicLink())continue;
      const file=path.join(dir,entry.name);
      if(entry.isDirectory())await walk(file);
      else if(entry.isFile()&&!/\.friloverse-[a-f0-9]+\.tmp$/i.test(entry.name))files.push(file);
    }
  };
  await walk(root);
  return files;
}

/** null if the import has not run yet. A marker that cannot be read still says it has. */
async function readMarker(marker){
  let text;
  try{text=await readFile(marker,'utf8');}catch(error){return error.code==='ENOENT'?null:{};}
  try{const saved=JSON.parse(text);return saved&&typeof saved==='object'?saved:{};}catch{return {};}
}

/** Every file in the old libraries, or on a later start only the ones that could not be copied. */
async function sourceFiles(source,pending,onProblem){
  const files=[];
  if(!pending){
    for(const name of LIBRARIES){
      const root=path.join(source,name);
      for(const file of await walkFiles(root,onProblem))files.push({root,file});
    }
    return files;
  }
  for(const relative of pending){
    const [name,...rest]=relative.split('/');
    if(!LIBRARIES.includes(name)||rest.some(part=>!part||part==='.'||part==='..'))continue;
    const root=path.join(source,name),item=path.join(root,...rest);
    try{
      const info=await lstat(item);
      if(info.isSymbolicLink())continue;
      if(info.isDirectory())for(const file of await walkFiles(item,onProblem))files.push({root,file});
      else if(info.isFile())files.push({root,file:item});
    }catch(error){if(error.code!=='ENOENT')onProblem(item,error);}
  }
  return files;
}

/**
 * Copy missing files from the old database once. A current Friloverse copy always wins.
 * One file that cannot be copied never stops the others. The marker is written anyway and names
 * that file, so only it is tried at the next starts: a skin the player has since deleted from
 * the Friloverse library is not brought back.
 */
export async function importLegacyCustomLibraries({localAppData=localAppDataRoot(),onProgress=()=>{}}={}){
  const source=path.join(localAppData,'FrYiLoCo');
  const target=friloverseDatabaseRoot(localAppData);
  const marker=path.join(target,'.legacy-custom-imported');
  const saved=await readMarker(marker);
  const retry=Array.isArray(saved?.pending)?saved.pending.filter(item=>typeof item==='string'):[];
  const tries=saved?Number(saved.tries)||1:0;
  if(saved&&(!retry.length||tries>=MAX_IMPORT_TRIES))return {copied:0,total:0,skipped:true};
  const shortName=file=>path.relative(source,file).split(path.sep).join('/');
  const failed=new Map(),leftOut=[];
  const failure=(file,error)=>failed.set(shortName(file),error.message);
  const files=await sourceFiles(source,saved?retry:null,failure);
  const missing=[];
  for(const item of files){
    const relative=path.relative(item.root,item.file);
    if(relative.startsWith('..')||path.isAbsolute(relative))continue;
    const destination=path.join(target,path.basename(item.root),relative);
    try{
      const info=await lstat(destination);
      // A folder or link has its name. It is the current library's, so this file stays behind for good.
      if(!info.isFile()||info.isSymbolicLink())leftOut.push({file:shortName(item.file),problem:'something else has its name in the custom database'});
    }catch(error){
      if(error.code==='ENOENT')missing.push({...item,destination});
      else failure(item.file,error);
    }
  }
  let copied=0,done=0;
  for(const item of missing){
    try{
      await mkdir(path.dirname(item.destination),{recursive:true});
      await copyFile(item.file,item.destination,constants.COPYFILE_EXCL).then(()=>{copied++;},error=>{if(error.code!=='EEXIST')throw error;});
    }catch(error){failure(item.file,error);}
    onProgress(++done,missing.length);
  }
  const pending=[...failed.keys()];
  try{
    await mkdir(target,{recursive:true});
    await writeFile(marker,JSON.stringify({version:1,importedAt:new Date().toISOString(),files:missing.length,...(pending.length?{pending,tries:tries+1}:{})}),'utf8');
  }catch(error){failed.set('.legacy-custom-imported',error.message);}
  return {copied,total:missing.length,...(failed.size?{failed:[...failed].map(([file,problem])=>({file,problem}))}:{}),...(leftOut.length?{leftOut}:{})};
}

/** What the player is told about old files an import could not bring over, or nothing. */
export function importProblem({failed=[],leftOut=[]}={}){
  const count=failed.length+leftOut.length;
  return count?`${count} old custom file${count===1?'':'s'} could not be imported. ${count===1?'It is':'They are'} still in your old skins folder, unchanged.`:'';
}

/**
 * Copy the old collection's artwork map once. It is keyed by package Git blob
 * hash, exactly what SkinDatabase computes, so imported packages keep their art
 * without Friloverse asking the collection for anything again.
 */
export async function loadCustomArtwork({dataDir,databaseRoot=friloverseDatabaseRoot(),legacyIndex}={}){
  const file=path.join(databaseRoot,'custom-artwork.json');
  try{
    const saved=JSON.parse(await readFile(file,'utf8'));
    if(saved?.version===1&&saved.artwork&&typeof saved.artwork==='object')return saved.artwork;
  }catch{}
  const source=legacyIndex||path.join(dataDir,'collection-index.json');
  try{
    const saved=JSON.parse(await readFile(source,'utf8'));
    const artwork={};
    for(const item of saved?.files||[]){
      if(typeof item?.sha==='string'&&/^[a-f0-9]{40}$/.test(item.sha)&&typeof item.artwork==='string'&&/^https:\/\/raw\.githubusercontent\.com\//.test(item.artwork))artwork[item.sha]=item.artwork;
    }
    await mkdir(databaseRoot,{recursive:true});
    await writeFile(file,JSON.stringify({version:1,artwork},null,2),'utf8');
    return artwork;
  }catch{return {};}
}

