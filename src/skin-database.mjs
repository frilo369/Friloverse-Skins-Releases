import {createHash} from 'node:crypto';
import {readdir,lstat} from 'node:fs/promises';
import path from 'node:path';
import yauzl from 'yauzl';
import {championKey} from './model.mjs';
import {gitBlobHash} from './git-blob.mjs';
import {MODPKG,readModpkgCard} from './modpkg.mjs';

const MAX_METADATA=256*1024,MAX_IMAGE=3*1024*1024;
// Bellion thumbnail: https://www.divineskins.gg/ikiryou/bellion-aatrox
const DIVINE_ARTWORK={'1aaad9694da4b8aa687937480a8ba7303c209082':'artwork/bellion.webp'};
function nameFromFile(file){return path.basename(file).replace(/\.(fantome|modpkg)$/i,'').replace(/[-_]v\d+(?:\.\d+)*(?:[-_][a-z0-9]+)?$/i,'').replace(/[_]+/g,' ').trim();}
async function readSmall(zip,entry,limit){
  if(entry.uncompressedSize>limit)return null;
  const stream=await zip.openReadStreamPromise(entry);const chunks=[];let size=0;
  for await(const chunk of stream){size+=chunk.length;if(size>limit){stream.destroy();throw new Error('Archive metadata exceeds its size limit.');}chunks.push(chunk);}
  return Buffer.concat(chunks);
}
async function readMetadata(file,mode,open,readCard){
  const result={};let zip;
  try{
    // LTK's own .modpkg (10.1) has its name and picture in its _meta_ files.
    if(MODPKG.test(file))return await readCard(file,{imageLimit:MAX_IMAGE});
    zip=await open(file,{autoClose:false,validateEntrySizes:true});let count=0;
    for await(const entry of zip.eachEntry()){
      if(++count>5000)break;
      const key=entry.fileName.replaceAll('\\','/').toLowerCase();
      if(key==='meta/info.json'){
        const data=await readSmall(zip,entry,MAX_METADATA);
        if(data){const info=JSON.parse(data.toString('utf8').replace(/^\uFEFF/,''));result.name=String(info.Name||info.name||'').trim().slice(0,140);result.author=String(info.Author||info.author||'').trim().slice(0,100);result.version=String(info.Version||info.version||'').trim().slice(0,60);}
      }else if(/^meta\/(?:image|thumbnail|preview)\.(?:png|jpe?g|webp)$/i.test(key)){
        const data=await readSmall(zip,entry,MAX_IMAGE);
        if(data)result.image={type:`image/${path.extname(key).slice(1).replace('jpg','jpeg')}`,bytes:data};
      }
      if(result.name && (result.image || count>1000))break;
    }
  }catch(error){
    // A file another program has open says nothing about the file: it is read again next time.
    // Only a .fantome is known to be a zip, and only a custom skin's preparing needs its metadata.
    // A .modpkg that its own reader cannot read is damaged too.
    if(error.syscall)result.unread=error.message;
    else if(MODPKG.test(file)||/\.fantome$/i.test(file)&&(mode==='skins'||!(error instanceof SyntaxError)))result.damaged=error.message;
  }
  finally{zip?.close();}
  return result;
}

/** Archives in the player's own folders. They are read here and never changed. */
export class SkinDatabase {
  // `local` is the player's own LocalSkins (10.0): the same champion folders, its own card ids
  // and picture address, and never looked through for a friend's skin.
  constructor({root=path.join(process.env.LOCALAPPDATA||path.join(process.env.USERPROFILE||'','AppData','Local'),'friloverse-skins-data','Database','Custom Skins'),champions=[],mode='skins',local=false,onProblem=()=>{},imageBytes=64*1024*1024,io={}}={}){
    if(!['skins','mods'].includes(mode)||local&&mode!=='skins')throw new Error('Unknown custom database mode.');
    this.root=path.resolve(root);this.champions=champions;this.mode=mode;this.local=!!local;this.imageBytes=imageBytes;
    this.prefix=mode==='mods'?'moddb':local?'local':'db';
    this.metadata=new Map();this.entries=new Map();this.artwork={...DIVINE_ARTWORK};this.onProblem=onProblem;this.told=new Set();this.io={lstat,readdir,hash:gitBlobHash,open:(file,options)=>yauzl.openPromise(file,options),modpkg:readModpkgCard,...io};
  }
  async metadataFor(file,fingerprint){
    const known=this.metadata.get(file),same=known?.fingerprint===fingerprint;
    if(same&&!known.unread&&!known.evicted){
      // Last used goes last in the map, so the oldest pictures are the first let go.
      this.metadata.delete(file);this.metadata.set(file,known);
      return known;
    }
    const cached={fingerprint,...(same&&known.blob?{blob:known.blob}:{}),...await readMetadata(file,this.mode,this.io.open,this.io.modpkg)};
    this.metadata.delete(file);this.metadata.set(file,cached);
    return cached;
  }
  /** Pictures stay for the champions seen lately. Past the budget the oldest go, never one just listed; a later list reads them again. */
  trimImages(listed){
    let total=0;
    for(const entry of this.metadata.values())total+=entry.image?.bytes.length||0;
    for(const [file,entry] of this.metadata){
      if(total<=this.imageBytes)break;
      if(!entry.image||listed.has(file))continue;
      total-=entry.image.bytes.length;delete entry.image;entry.evicted=true;
    }
  }
  setArtwork(artwork){this.artwork={...artwork,...DIVINE_ARTWORK};}
  aliases(champion){
    const key=championKey(champion);const match=this.champions.find(c=>championKey(c.id)===key||championKey(c.name)===key);
    return new Set([key,championKey(match?.id),championKey(match?.name)].filter(Boolean));
  }
  async list(champion){
    const aliases=this.aliases(champion),files=[],problems=[];
    // One file or folder that cannot be read costs only itself. A list that fails is read every 3 s, so each is told once.
    const problem=(file,error)=>{
      const row={file:path.relative(this.root,file),problem:error?.message||String(error)};problems.push(row);
      const said=`${row.file}|${row.problem}`;
      if(!this.told.has(said)){this.told.add(said);this.onProblem(row);}
    };
    try{
      const rootInfo=await this.io.lstat(this.root);if(!rootInfo.isDirectory()||rootInfo.isSymbolicLink())throw new Error('Invalid database directory');
      const walk=async(dir,depth)=>{
        if(depth>4)return;
        let items;
        try{items=await this.io.readdir(dir,{withFileTypes:true});}
        catch(error){if(dir===this.root)throw error;if(error.code!=='ENOENT')problem(dir,error);return;}
        for(const item of items){
          if(item.isSymbolicLink())continue;
          const full=path.join(dir,item.name);
          if(item.isDirectory())await walk(full,depth+1);
          else if(item.isFile()&&/\.(?:fantome|modpkg)$/i.test(item.name))files.push(full);
        }
      };
      if(this.mode==='mods')await walk(this.root,0);
      else for(const entry of await this.io.readdir(this.root,{withFileTypes:true})){
        if(entry.isDirectory()&&!entry.isSymbolicLink()&&aliases.has(championKey(entry.name)))await walk(path.join(this.root,entry.name),0);
      }
    }catch(error){if(error.code==='ENOENT')return {skins:[],available:false};throw error;}
    // Bound disk work while preserving sorted card order. A picture-less archive must be
    // hashed for collection art, but need not hold up every other card serially.
    const sorted=files.sort((a,b)=>a.localeCompare(b,'en')),skins=new Array(files.length);
    let cursor=0;
    const readCard=async(file,index)=>{
      let stat;
      try{stat=await this.io.lstat(file);}catch(error){if(error.code!=='ENOENT')problem(file,error);return;}
      if(!stat.isFile()||stat.isSymbolicLink())return;
      const id=`${this.prefix}:${createHash('sha256').update(path.relative(this.root,file).toLowerCase().replaceAll('\\','/')).digest('hex')}`;
      const fingerprint=`${stat.size}:${stat.mtimeMs}`;
      const cached=await this.metadataFor(file,fingerprint);
      if(cached.damaged)problem(file,new Error(`it is damaged (${cached.damaged})`));
      else if(cached.unread)problem(file,new Error(cached.unread));
      // Only its picture depends on this, so a locked file keeps its card and is tried again next time.
      if(this.mode==='skins'&&!cached.image&&!cached.blob)cached.blob=await this.io.hash(file,stat.size).catch(error=>{problem(file,error);return undefined;});
      const name=cached.name||nameFromFile(file);
      this.entries.set(id,{id,file,champion:championKey(champion),fingerprint,name});
      skins[index]={id,kind:'custom',source:this.local?'local':'database',name,author:cached.author||'',enabled:false,broken:!!cached.damaged,image:cached.image?`friloverse-icon://${this.local?'local':'custom'}/${id.slice(id.indexOf(':')+1)}`:this.artwork[cached.blob]||''};
    };
    await Promise.all(Array.from({length:Math.min(4,sorted.length)},async()=>{
      while(cursor<sorted.length){const index=cursor++;await readCard(sorted[index],index);}
    }));
    this.trimImages(new Set(files));
    return {skins:skins.filter(Boolean),available:true,...(problems.length?{problems}:{})};
  }
  /** The picture inside an archive. It is served to the windows, as it can be megabytes and state goes out often. */
  embeddedImage(hash){
    const entry=this.entries.get(`${this.prefix}:${hash}`);
    return entry?this.metadata.get(entry.file)?.image||null:null;
  }
  /** Git's name for an archive's contents, as the shared collections use it. */
  async blobFor(file){
    const stat=await lstat(file);
    if(!stat.isFile()||stat.isSymbolicLink())return null;
    const fingerprint=`${stat.size}:${stat.mtimeMs}`;
    const cached=await this.metadataFor(file,fingerprint);
    if(!cached.blob)cached.blob=await gitBlobHash(file,stat.size);
    return cached.blob;
  }
  /** This champion's local archive with exactly these contents, as a card id. */
  async findArchive(champion,blob){
    if(this.mode!=='skins'||this.local||!/^[0-9a-f]{40}$/.test(String(blob||'')))return null;
    const listed=await this.list(champion);
    for(const skin of listed.skins){
      const entry=this.entries.get(skin.id);
      try{if(entry&&await this.blobFor(entry.file)===blob)return skin.id;}catch{}
    }
    return null;
  }
  /** The unchanged file behind a card, with the hash that identifies it in a party. */
  async resolve(id,champion=''){
    const entry=this.entries.get(id);
    if(!entry||(this.mode==='skins'&&entry.champion!==championKey(champion)))throw new Error('This package is no longer available for the selected champion.');
    const info=await lstat(entry.file);
    if(!info.isFile()||info.isSymbolicLink()||`${info.size}:${info.mtimeMs}`!==entry.fingerprint)throw new Error('This skin file changed. Reopen the skin panel and try again.');
    const key=await this.blobFor(entry.file);
    if(!key)throw new Error('This skin file could not be read.');
    return {id,key,file:entry.file,label:entry.name};
  }
}
