import {createHash,randomBytes} from 'node:crypto';
import {copyFile,lstat,mkdir,readFile,rename,unlink,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {buildCustomSkinCopy,COMPAT_REVISION,hasShaderWads,sourceHash} from './custom-skin-compat.mjs';
import {leagueFolder} from './league-client.mjs';
import {resolveLtkExecutable} from './ltk.mjs';

const BLOB=/^[a-f0-9]{40}$/,SHA256=/^[a-f0-9]{64}$/,ARCHIVE=/^[a-f0-9]{64}\.fantome$/;
const FILE_BUSY=new Set(['EPERM','EBUSY','EACCES']);
const plain=message=>Object.assign(new Error(message),{plain:true});
const couldNotPrepare=label=>plain(`${label||'This custom skin'} could not be prepared for this version of League. Choose another skin.`);

/** A cheap identity for an installed program; a patch invalidates prepared copies. */
export async function fileFingerprint(file){
  const info=await lstat(file);
  if(!info.isFile()||info.isSymbolicLink())throw new Error('A regular file is required.');
  return `${info.size}:${info.mtimeMs}`;
}

/** Used by the match-time lookup. */
export async function environmentFingerprint({league=leagueFolder,manager=resolveLtkExecutable}={}){
  const [leaguePath,managerPath]=await Promise.all([
    typeof league==='function'?league():league,
    typeof manager==='function'?manager():manager,
  ]);
  const [gameFingerprint,managerFingerprint]=await Promise.all([
    fileFingerprint(path.join(leaguePath,'Game','League of Legends.exe')),
    fileFingerprint(managerPath),
  ]);
  return {gameFingerprint,managerFingerprint};
}

export async function writeJsonAtomic(file,value){
  const temp=`${file}.${randomBytes(6).toString('hex')}.tmp`;
  try{await writeFile(temp,JSON.stringify(value,null,2),{flag:'wx'});await rename(temp,file);}
  finally{await unlink(temp).catch(()=>{});}
}

/**
 * The manifest to go on with. After a League or LTK update the copies stay, marked `stale`: one
 * can still be used once LTK has checked it, so a patch never takes a player's skins away. A new
 * COMPAT_REVISION drops them, as those copies were made in a way that is now wrong.
 */
export function currentManifest(manifest,environment){
  const usable=manifest?.version===1&&manifest.compatRevision===COMPAT_REVISION&&manifest.entries&&typeof manifest.entries==='object'&&!Array.isArray(manifest.entries);
  if(!usable)return {version:1,compatRevision:COMPAT_REVISION,...environment,entries:{}};
  if(manifest.gameFingerprint!==environment.gameFingerprint||manifest.managerFingerprint!==environment.managerFingerprint){
    for(const entry of Object.values(manifest.entries))entry.stale=true;
    Object.assign(manifest,environment);
  }
  return manifest;
}

/** What a skin should load from. Never installs, repairs, or changes an archive. */
export class PreparedSkinLibrary{
  constructor({dataDir,league=leagueFolder,manager=resolveLtkExecutable,buildCopy=buildCustomSkinCopy}){
    this.dir=path.join(dataDir,'prepared-skins');this.manifestPath=path.join(this.dir,'manifest.json');
    Object.assign(this,{league,manager,buildCopy});this.manifest=null;this.manifestFingerprint='';this.verified=new Map();
  }
  async load(){
    const fingerprint=await fileFingerprint(this.manifestPath);
    if(this.manifest&&fingerprint===this.manifestFingerprint)return this.manifest;
    const data=JSON.parse(await readFile(this.manifestPath,'utf8'));
    if(data?.version!==1||data.compatRevision!==COMPAT_REVISION||typeof data.gameFingerprint!=='string'||typeof data.managerFingerprint!=='string'||!data.entries||typeof data.entries!=='object'||Array.isArray(data.entries))throw new Error('This manifest cannot be used.');
    this.manifest=data;this.manifestFingerprint=fingerprint;this.verified.clear();return data;
  }
  async intact(entry,pick){
    if(entry?.status!=='ready'||!ARCHIVE.test(entry.file||'')||!SHA256.test(entry.sha256||'')||!SHA256.test(entry.sourceHash||''))return false;
    if(pick.alias&&String(entry.champion||'').toLowerCase()!==String(pick.alias).toLowerCase())return false;
    const file=path.join(this.dir,entry.file);
    try{
      const fingerprint=await fileFingerprint(file),cached=this.verified.get(file);
      if(!cached||cached.fingerprint!==fingerprint||cached.sha256!==entry.sha256){
        const sha256=createHash('sha256').update(await readFile(file)).digest('hex');
        if(sha256!==entry.sha256)return false;
        this.verified.set(file,{fingerprint,sha256});
      }
    }catch{return false;}
    return true;
  }
  /**
   * `prepared` says LTK has already checked this copy for this League, so the engine need not.
   * Otherwise it checks and repairs what it installs: an old copy, or one made here and now, so
   * a player is never told to wait for a skin they picked.
   */
  async resolve(pick){
    if(pick?.trusted)return pick;
    if(!BLOB.test(pick?.key||''))throw couldNotPrepare(pick?.label);
    const [manifest,current]=await Promise.all([this.load().catch(()=>null),environmentFingerprint({league:this.league,manager:this.manager}).catch(()=>null)]);
    const entry=manifest?.entries[pick.key];
    const fresh=!!current&&manifest?.gameFingerprint===current.gameFingerprint&&manifest?.managerFingerprint===current.managerFingerprint&&!entry?.stale;
    // A copy with shaders holds League's shader list of its day: after a patch it is made again.
    if(!(entry?.shaders&&!fresh)&&await this.intact(entry,pick))return {...pick,file:path.join(this.dir,entry.file),prepared:fresh};
    return this.prepareNow(pick);
  }
  /** Prepares one skin at its pick. LTK's Repair then runs on what the engine installs. */
  async prepareNow(pick){
    try{
      const league=typeof this.league==='function'?await this.league():this.league;
      const copy=await this.buildCopy({file:pick.file,champion:pick.alias||null,dir:path.join(this.dir,'working'),league});
      return {...pick,file:copy.file,prepared:false,working:true};
    }catch(error){
      if(FILE_BUSY.has(error?.code))throw error;
      throw couldNotPrepare(pick.label);
    }
  }
  /** Keep what LTK has just accepted and repaired, so the next pick has nothing to do. */
  async keep(pick,mod){
    if(!BLOB.test(pick?.key||'')||mod?.storage!=='archive'||mod.format!=='fantome'||!mod.hasArchive||!mod.slug||!path.isAbsolute(mod.modDir||''))return false;
    const source=await sourceHash(pick.file);
    const environment=await environmentFingerprint({league:this.league,manager:this.manager});
    const saved=await readFile(this.manifestPath,'utf8').then(JSON.parse).catch(()=>null);
    const manifest=currentManifest(saved,environment);
    await mkdir(this.dir,{recursive:true});
    const name=`${source}.fantome`,destination=path.join(this.dir,name),temp=`${destination}.${randomBytes(6).toString('hex')}.tmp`;
    try{await copyFile(`${mod.modDir}.fantome`,temp);await rename(temp,destination);}
    finally{await unlink(temp).catch(()=>{});}
    const shaders=!!pick.alias&&await hasShaderWads(pick.file).catch(()=>true);
    manifest.entries[pick.key]={status:'ready',file:name,sha256:await sourceHash(destination),copy:await fileFingerprint(destination),sourceHash:source,champion:pick.alias||null,label:pick.label||'',...(shaders?{shaders:true}:{})};
    await writeJsonAtomic(this.manifestPath,manifest);
    this.manifest=null;
    return true;
  }
}
