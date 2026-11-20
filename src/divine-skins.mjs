import path from 'node:path';
import {link,lstat,mkdir,open,readdir,stat,unlink} from 'node:fs/promises';
import yauzl from 'yauzl';
import {fileHash,gitBlobHash} from './git-blob.mjs';
import {championFolder} from './local-skins.mjs';
import {championKey} from './model.mjs';
import {modpkgWadNames} from './modpkg.mjs';

export const DIVINE_CATALOGUE='https://divineskins.gg/mods/lol';
export const MAX_DOWNLOAD=1024**3;
// 12.9 (owner): each Divine skin a player saves is recorded by the owner's logs Worker, so the
// owner can add popular ones to the GitHub collection by hand. Only the skin is sent (its Divine
// link, champion, file name, size and Git blob hash), never anything about the player.
export const DOWNLOAD_SERVICE='https://friloverse-logs.ogfryilo.workers.dev/divine-downloads';

// The website's champion label identifies the intended champion, including skins with
// shared assets or several champion WADs. Only the local catalogue supplies folder names.
export function divineSelection(pick,champions){
  const url=divineDownloadUrl(pick?.route);
  const key=championKey(pick.champion);
  const champion=champions.find(row=>championKey(row.id)===key||championKey(row.name)===key);
  if(!champion)throw new Error('Friloverse does not recognize the champion on this card.');
  return {url,champion};
}

/** A skin page route (`/<artist>/<slug>`) as its download page, or an error. */
export function divineDownloadUrl(route){
  if(typeof route!=='string'||route.length>500||!/^\/(?:[\w.~-]|%[\da-f]{2})+\/(?:[\w.~-]|%[\da-f]{2})+$/i.test(route)||
    /^\/(?:mods|download)\//i.test(route)||
    route.slice(1).split('/').some(part=>{try{return /^(?:\.|\.\.)$|[/\\?#\x00-\x1f]/.test(decodeURIComponent(part));}catch{return true;}}))
    throw new Error('This Divine skin link could not be opened.');
  return new URL('/download'+route,DIVINE_CATALOGUE).href;
}

/** "iron-darius" from `/Frog/iron-darius` as "Iron Darius", for progress lines. */
export function divineSkinLabel(route){
  let slug=String(route||'').split('/').filter(Boolean).at(-1)||'';
  try{slug=decodeURIComponent(slug);}catch{}
  return slug.replace(/[-_]+/g,' ').trim().replace(/\b\p{Ll}/gu,letter=>letter.toUpperCase())||'This skin';
}

export function divineOrigin(raw,{cdn=false}={}){
  try{
    const url=new URL(raw);
    if(url.protocol==='blob:')return divineOrigin(url.origin);
    return url.protocol==='https:'&&!url.username&&!url.password&&!url.port&&
      (url.hostname==='divineskins.gg'||url.hostname.endsWith('.divineskins.gg')||
        cdn&&(url.hostname==='divine-cdn.com'||url.hostname.endsWith('.divine-cdn.com')));
  }catch{return false;}
}

async function directory(dir){
  await mkdir(dir,{recursive:true});
  const info=await lstat(dir);
  if(!info.isDirectory()||info.isSymbolicLink())throw new Error('The skin folder must be a regular folder.');
}

// Outside LocalSkins, on the same volume for atomic publication. Clean only our unfinished
// downloads after a crash. The main process allows only one import at a time.
export async function prepareDownload(root){
  const dir=path.join(path.dirname(root),'DivineImports');
  await directory(dir);
  for(const entry of await readdir(dir,{withFileTypes:true})){
    if(entry.isFile()&&/^skin-[a-f0-9-]{36}\.part(?:\.crdownload)?$/i.test(entry.name))await unlink(path.join(dir,entry.name));
  }
  return dir;
}

export async function inspectDownload(file,filename,champions){
  const handle=await open(file,'r');
  const magic=Buffer.alloc(8);
  try{
    const {size}=await handle.stat();
    if(!size||size>MAX_DOWNLOAD)throw new Error('This skin file is empty or over 1 GB.');
    await handle.read(magic,0,8,0);
  }finally{await handle.close();}
  let extension,wads;
  if(magic.toString('ascii')==='_modpkg_'){
    extension='.modpkg';
    wads=await modpkgWadNames(file,{checkContents:true});
    if(!wads.some(name=>/\.wad\.client$/i.test(name)))throw new Error('This package contains no League WADs.');
  }else if(magic.readUInt32LE()===0x04034b50){
    extension='.fantome';
    wads=[];
    const zip=await yauzl.openPromise(file,{autoClose:false});
    try{
      let hasAssets=false,total=0;
      if(zip.entryCount>65535)throw new Error('There are too many files in this skin.');
      for await(const entry of zip.eachEntry()){
        const normalized=String(entry.fileName||'').replaceAll('\\','/');
        if(normalized.startsWith('/')||/^[a-z]:/i.test(normalized)||normalized.split('/').includes('..')){
          throw new Error('The download contains an unsafe file path.');
        }
        total+=entry.uncompressedSize;
        if(total>MAX_DOWNLOAD)throw new Error('The unpacked skin is over 1 GB.');
        if(!entry.uncompressedSize)continue;
        const match=/^wad\/([^/]+\.wad\.client)(?:\/|$)/i.exec(normalized);
        if(match)wads.push(match[1]);
        if(match||/^raw\//i.test(normalized))hasAssets=true;
      }
      if(!hasAssets)throw new Error('The download contains no Fantome skin assets.');
    }finally{zip.close();}
  }else throw new Error('Choose a .fantome or .modpkg skin file on Divine.');
  const keys=new Set(wads.map(name=>championKey(path.win32.basename(name).replace(/(?:\.[a-z]{2}_[a-z]{2})?\.wad\.client$/i,''))));
  const matches=champions.filter(row=>keys.has(championKey(row.id))||keys.has(championKey(row.name)));
  const raw=path.win32.basename(filename).replace(/\.(?:fantome|modpkg|zip)$/i,'');
  let stem=championFolder(raw.slice(0,110));
  if(!stem||/^(?:con|prn|aux|nul|com\d|lpt\d)(?:\.|$)/i.test(stem))stem='Divine skin';
  return {name:stem+extension,suggested:matches.length===1?matches[0].id:''};
}

// A hard link makes a completed file visible in one operation and fails if the name exists.
// Identical repeat downloads reuse it. A different version keeps both files.
export async function saveDivineSkin(root,download,champions,id){
  const folder=championFolder(champions.find(row=>row.id===id)?.name);
  if(!folder)throw new Error('Choose a champion for this skin.');
  await directory(root);
  const dir=path.join(root,folder);
  await directory(dir);
  const ext=path.extname(download.name);
  let name=download.name,hash;
  for(let attempt=0;attempt<2;attempt++){
    const target=path.join(dir,name);
    try{await link(download.file,target);return {folder,name,already:false};}
    catch(error){if(error.code!=='EEXIST')throw error;}
    hash??=await fileHash(download.file,'sha256');
    const existing=await lstat(target);
    if(existing.isFile()&&!existing.isSymbolicLink()&&await fileHash(target,'sha256')===hash)return {folder,name,already:true};
    name=download.name.slice(0,-ext.length)+' ('+hash.slice(0,12)+')'+ext;
  }
  throw new Error('Both local file names are in use. Rename the conflicting file and try again.');
}

/**
 * Tells the owner's Worker that a Divine skin was saved. Never throws and never holds up the
 * import: a record that cannot be sent is simply not counted.
 */
export async function reportDivineDownload({route,champion,file,version,fetchFn=fetch,url=DOWNLOAD_SERVICE}){
  try{
    const {size}=await stat(file);
    const sha=await gitBlobHash(file,size);
    const response=await fetchFn(url,{method:'POST',signal:AbortSignal.timeout(15000),
      headers:{'content-type':'application/json','x-friloverse-version':version},
      body:JSON.stringify({route,champion,file:path.basename(file),size,sha})});
    return response.ok;
  }catch{return false;}
}
