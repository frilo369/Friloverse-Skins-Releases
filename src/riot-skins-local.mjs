import {watch} from 'node:fs';
import {createHash,randomBytes} from 'node:crypto';
import {mkdir,readFile,readdir,rename,rmdir,stat,unlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {buildSkinCards,chromaAppearanceUrl,groupCatalog,isFormSkin} from './fryilo-catalog/catalog.mjs';
import {gitBlobHash} from './git-blob.mjs';
import {latestRelease,readRefs} from './github-refs.mjs';
import {readWithProgress} from './read-progress.mjs';
import {riotSkinUnavailable} from './riot-skin-availability.mjs';
export {RIOT_SKINS_OFF,setRiotSkinsOff} from './riot-skin-availability.mjs';

const MANIFEST='riot-skins-manifest.json',NAMES='riot-skins-names.json',LIST='riot-skins-list.json',MAX_SKIN=256*1024*1024;
const FILES_AT_ONCE=16,REMOVED_AT_ONCE=32;
const NO_SKINS=Object.freeze([]);
const PLACEHOLDER=/^\d+$|^Skin \d+$|^Chroma \d+$|\((?:Chroma|Version) \d+\)$/;
// Riot's own game data as CommunityDragon publishes it: every skin, chroma and form by
// number, so one newer than the bundled catalogue still has its real name.
export const NAMES_URL='https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/default/v1/skins.json';
// The catalogue: every Riot skin this app offers, by champion and number, with the hash friends'
// PCs recognise it by. The list is all an ordinary skin takes from GitHub (7.3, owner's request):
// what goes in the game is built from the installed League (src/riot-skin-builder.mjs). Only a
// form has no League skin slot to build from, so the forms' files are the one thing downloaded.
export const DATABASE_REPO='frilo369/Friloverse_Skins_Database',DATABASE_BRANCH='main';
const rawFile=(revision,relative)=>`https://raw.githubusercontent.com/${DATABASE_REPO}/${revision}/${relative.split('/').map(encodeURIComponent).join('/')}`;

/** Real names by skin, chroma and form number, out of CommunityDragon's skins.json. */
export function skinNames(data){
  const names=new Map();
  const add=row=>{
    const name=typeof row?.name==='string'?row.name.trim():'';
    if(Number.isSafeInteger(row?.id)&&name&&!PLACEHOLDER.test(name))names.set(row.id,name);
  };
  for(const skin of data&&typeof data==='object'?Object.values(data):[]){
    add(skin);
    for(const chroma of Array.isArray(skin?.chromas)?skin.chromas:[])add(chroma);
    for(const tier of Array.isArray(skin?.questSkinInfo?.tiers)?skin.questSkinInfo.tiers:[])add(tier);
  }
  return names;
}
const splash=(champion,number)=>`https://ddragon.leagueoflegends.com/cdn/img/champion/splash/${champion.id}_${number}.jpg`;
// A chroma's CommunityDragon swatch is read from the installed League instead (friloverse-icon://chroma),
// so the picture does not wait on, or vanish with, CommunityDragon.
const CHROMA_SWATCH=/^https:\/\/raw\.communitydragon\.org\/latest\/plugins\/rcp-be-lol-game-data\/global\/default\/v1\/champion-chroma-images\/(\d+)\/(\d+)\.png$/;
const localArt=url=>url.replace(/^\/forms\//,'forms/').replace(CHROMA_SWATCH,'friloverse-icon://chroma/$1/$2');
const fileNumber=name=>/^(\d+)\.fantome(?:\.[0-9a-f]+\.tmp)?$/.exec(name)?.[1];
/** Whether a path in the list is a form's file, by the number in its name. */
const isFormPath=relative=>{const number=typeof relative==='string'?fileNumber(relative.split('/').at(-1)):undefined;return number!==undefined&&isFormSkin({id:Number(number)});};

export function riotCards(champion,entries){
  const files=entries.filter(entry=>!riotSkinUnavailable(entry.id))
    .map(entry=>({path:`riot:${entry.id}`,relative:entry.relative,name:String(entry.id),embeddedName:entry.name||undefined}));
  const {groups}=groupCatalog([champion],files);
  const fresh=new Map(files.map(file=>[file.path,file.embeddedName]));
  const named=file=>(PLACEHOLDER.test(file.name)&&fresh.get(file.path))||file.name;
  return buildSkinCards(groups[0].files,true).map(card=>{
    const number=card.base.skinNum,art=splash(champion,number),target=card.hasBase?card.base:card.chromas[0];
    const chromas=card.chromas.map(chroma=>({
      id:chroma.path,
      name:named(chroma).match(/\(([^)]+)\)\s*$/)?.[1]??named(chroma),
      image:localArt(chromaAppearanceUrl(champion.key,chroma))||art,
      fallback:art,
      ...(chroma.badge?{badge:chroma.badge}:{}),
      ...(chroma.formIcon?{formIcon:localArt(chroma.formIcon)}:{}),
      ...(chroma.appearanceOverlayUrl?{overlay:localArt(chroma.appearanceOverlayUrl)}:{}),
      ...(Array.isArray(chroma.colors)&&chroma.colors.length?{colors:chroma.colors}:{}),
    }));
    const hasForms=chromas.some(c=>c.badge==='FORM');
    const hasTiersOrEditions=chromas.some(c=>c.badge==='TIER'||c.badge==='EDITION');
    const variantKind=hasForms?'forms':hasTiersOrEditions?'editions':'chromas';
    return {
      id:target.path,kind:'riot',author:'',broken:false,
      name:card.hasBase?named(card.base):named(card.base).replace(/\s*\([^)]*\)\s*$/,''),
      image:art,
      fallback:`https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/default/v1/champion-splashes/${champion.key}/${Number(champion.key)*1000+number}.jpg`,
      variantKind,
      chromas,
    };
  });
}

export function manifestSkins(value){
  if(value?.version!==1||!Array.isArray(value.skins))throw new Error('The Riot skin list is damaged.');
  const skins=[];
  for(const row of value.skins){
    const champion=Number(row?.champion),id=Number(row?.id),relative=String(row?.relative||'').replaceAll(String.fromCharCode(92),'/');
    const parts=relative.split('/');
    if(!Number.isSafeInteger(champion)||champion<1||champion>99999||!Number.isSafeInteger(id)||id<0||id>9999999)continue;
    if(parts.length<3||parts.length>8||parts[0]!==String(champion)||parts.some(part=>!part||part==='.'||part==='..'||part.includes(':')))continue;
    if(parts.some((part,index)=>index>0&&index<parts.length-1&&!/^\d{1,7}$/.test(part)))continue;
    if(parts.at(-1)!==`${id}.fantome`||! /^[0-9a-f]{40}$/i.test(String(row.sha||'')))continue;
    if(!Number.isSafeInteger(row.size)||row.size<1||row.size>MAX_SKIN)continue;
    skins.push({
      id,champion,parent:Number.isSafeInteger(row.parent)?row.parent:(parts.length>=4?Number(parts.at(-3)):null),
      relative,path:`skins/${relative}`,sha:String(row.sha).toLowerCase(),size:row.size,name:typeof row.name==='string'?row.name:'',
    });
  }
  if(!skins.length)throw new Error('The Riot skin list has no skins.');
  return skins;
}

export class RiotCatalogue{
  constructor({root,onChange=null,fetchFn=fetch,buildSkin=null,onProgress=null}={}){
    // ({what:'list'|'names'|'files',bytes,total}) while something downloads; total 0 is unknown. 'files' also has files and count.
    this.onProgress=onProgress;
    const local=process.env.LOCALAPPDATA||path.join(process.env.USERPROFILE||'','AppData','Local');
    this.root=path.resolve(root||path.join(local,'friloverse-skins-data','Database','RiotSkins'));
    this.manifestFile=path.join(this.root,MANIFEST);
    this.namesFile=path.join(this.root,NAMES);
    this.listFile=path.join(this.root,LIST);
    Object.assign(this,{onChange,fetchFn});
    this.buildSkin=buildSkin||(async(skin,options)=>(await this.builder()).build(skin,options));
    this.commit='';this.generatedAt='';this.lastError='';this.remoteError='';this.byChampion=new Map();this.byBlob=new Map();this.pending=new Map();this.watcher=null;this.watchTimer=null;
    // Names the converter could not write: the archive list is older than Riot's data.
    this.names=new Map();this.namesEtag='';this.namesFor='';
    this.revision='';this.agreedAt='';this.localList=false;
    // Whether the files earlier versions downloaded and nothing reads have been removed (removeUnused).
    this.cleaned=false;this.removing=false;
    // Paths of forms' files not here yet; kept on disk so a closed app carries on.
    this.waiting=new Set();this.downloads=new Map();this.fetching=null;
  }
  /** A builder for callers that did not bring one; its copies live in the temp folder. */
  async builder(){
    if(!this.ownBuilder){
      const {RiotSkinBuilder}=await import('./riot-skin-builder.mjs');
      this.ownBuilder=new RiotSkinBuilder({cacheDir:path.join(tmpdir(),'friloverse-built-skins')});
    }
    return this.ownBuilder;
  }
  get ready(){return this.byChampion.size>0;}
  index({commit,skins}){
    this.commit=commit;this.byChampion=new Map();this.byBlob=new Map();
    for(const skin of skins){
      this.byBlob.set(`${skin.champion}:${skin.sha}`,skin);
      const list=this.byChampion.get(skin.champion);
      if(list)list.push(skin);else this.byChampion.set(skin.champion,[skin]);
    }
    this.applyNames();
  }
  /** Every skin the catalogue lists, in a stable order. */
  skins(){return [...this.byChampion.values()].flat();}
  /** A name Riot owns beats the number a stale archive list fell back to. */
  applyNames(){
    for(const list of this.byChampion.values())for(const skin of list){
      const name=this.names.get(skin.id);
      if(name&&(!skin.name||PLACEHOLDER.test(skin.name)))skin.name=name;
    }
  }
  async loadNames(){
    try{
      const saved=JSON.parse(await readFile(this.namesFile,'utf8')),names=new Map();
      for(const [key,value] of Object.entries(saved?.names||{})){
        const id=Number(key);
        if(Number.isSafeInteger(id)&&typeof value==='string'&&value.trim())names.set(id,value.trim());
      }
      this.names=names;
      this.namesEtag=typeof saved?.etag==='string'?saved.etag:'';
      this.namesFor=typeof saved?.generatedAt==='string'?saved.generatedAt:'';
    }catch{/* The next check asks Riot. */}
  }
  async saveNames(){
    if(!this.names.size)return;
    const temp=`${this.namesFile}.${randomBytes(8).toString('hex')}.tmp`;
    try{
      await writeFile(temp,JSON.stringify({version:1,etag:this.namesEtag,generatedAt:this.namesFor,names:Object.fromEntries(this.names)}),{encoding:'utf8',flag:'wx'});
      await rename(temp,this.namesFile);
    }finally{await unlink(temp).catch(()=>{});}
  }
  /** The GitHub revision this PC last agreed with, and the list version it settled on. */
  async loadList(){
    try{
      const saved=JSON.parse(await readFile(this.listFile,'utf8'));
      if(typeof saved?.revision==='string'&&/^[0-9a-f]{40}$/.test(saved.revision))this.revision=saved.revision;
      if(typeof saved?.agreedAt==='string')this.agreedAt=saved.agreedAt;
      this.localList=saved?.localList===true;
      this.cleaned=saved?.cleaned===1;
      // A list saved by 7.2 or older can name thousands of ordinary skins' files.
      this.waiting=new Set((Array.isArray(saved?.waiting)?saved.waiting:[]).filter(isFormPath));
    }catch{/* The next check asks GitHub. */}
  }
  async saveList(){
    if(!this.revision&&!this.waiting.size&&!this.cleaned)return;
    const temp=`${this.listFile}.${randomBytes(8).toString('hex')}.tmp`;
    try{
      await writeFile(temp,JSON.stringify({version:1,revision:this.revision,agreedAt:this.agreedAt,localList:this.localList,cleaned:this.cleaned?1:0,waiting:[...this.waiting].sort()}),{encoding:'utf8',flag:'wx'});
      await rename(temp,this.listFile);
    }finally{await unlink(temp).catch(()=>{});}
  }
  /**
   * The commit of the newest GitHub release, so an upload reaches nobody until a release is
   * published (7.2). Two small requests that cost none of GitHub's API limit. A repository
   * with no release at all is followed by its `main`, as every copy up to 7.1 does.
   */
  async remoteHead(){
    const tag=await latestRelease(this.fetchFn,DATABASE_REPO),refs=await readRefs(this.fetchFn,DATABASE_REPO);
    const revision=refs.get(tag?`refs/tags/${tag}`:`refs/heads/${DATABASE_BRANCH}`)||'';
    if(!/^[0-9a-f]{40}$/.test(revision))throw new Error('GitHub returned an invalid revision.');
    return revision;
  }
  /**
   * The catalogue's manifest, from the commit GitHub names. An unchanged revision costs
   * two small requests; a changed one also the manifest.
   */
  async checkRemote(){
    try{
      const revision=await this.remoteHead();
      this.remoteError='';
      // A list deleted from the disk is fetched again, even with an unchanged commit.
      if(revision===this.revision&&this.ready&&this.agreedAt&&await stat(this.manifestFile).then(()=>true,()=>false)){
        if(this.generatedAt===this.agreedAt)return {changed:false,revision};
        // An offline conversion newer than the release is this PC's list, not something to downgrade.
        if(this.generatedAt>this.agreedAt){this.agreedAt=this.generatedAt;this.localList=true;await this.saveList();return {changed:false,revision,adopted:true};}
      }
      // Uncompressed (about 2 MB instead of 0.45), so its size is known and the strip shows real progress (6.3).
      const response=await this.fetchFn(rawFile(revision,MANIFEST),{headers:{'Accept-Encoding':'identity'},signal:AbortSignal.timeout(120000)});
      if(!response.ok)throw new Error(`the list could not be downloaded (${response.status})`);
      const saved=response.body&&this.onProgress
        ?JSON.parse((await readWithProgress(response,progress=>this.onProgress({what:'list',...progress}))).toString('utf8'))
        :await response.json();
      const skins=manifestSkins(saved),listAt=typeof saved.generatedAt==='string'?saved.generatedAt:'';
      // A list file with no agreedAt is from before it was recorded: nothing says it is this PC's own.
      if(this.generatedAt&&listAt&&this.generatedAt>listAt&&(this.localList||this.agreedAt&&this.generatedAt!==this.agreedAt)){
        this.revision=revision;this.agreedAt=this.generatedAt;this.localList=true;
        await this.saveList();
        return {changed:false,revision,adopted:true};
      }
      await this.writeManifest(saved);
      this.revision=revision;
      this.agreedAt=listAt;
      this.localList=false;
      this.generatedAt=listAt;
      this.index({commit:`github-${revision.slice(0,7)}`,skins});
      this.lastError='';
      await this.saveList();
      return {changed:true,revision,count:skins.length};
    }catch(error){
      this.remoteError=`The Riot skin database could not be checked: ${error.message}.`;
      return {changed:false};
    }
  }
  /** Replaces the manifest atomically; the watcher then tells the app to refresh itself. */
  async writeManifest(value){
    await mkdir(this.root,{recursive:true});
    const temp=`${this.manifestFile}.${randomBytes(8).toString('hex')}.tmp`;
    try{await writeFile(temp,JSON.stringify(value),{encoding:'utf8',flag:'wx'});await rename(temp,this.manifestFile);}
    finally{await unlink(temp).catch(()=>{});}
  }
  /**
   * The catalogue, from GitHub when reachable and from the local copy otherwise.
   * True when the names it had to read from Riot changed the cards.
   */
  async check(){
    const ready=await this.load();
    if(!ready)await this.checkRemote();
    if(!this.ready)throw new Error(this.lastError||this.remoteError||'The Riot skin database could not be read.');
    return this.refreshNames();
  }
  async load(){
    await mkdir(this.root,{recursive:true});
    if(this.onChange)this.watchManifest();
    await this.loadNames();
    await this.loadList();
    try{
      return await this.readManifest(this.manifestFile);
    }catch(error){
      // Cards already showing are not taken away because the file cannot be read right now.
      if(this.ready)return true;
      this.index({commit:'local',skins:[]});
      this.generatedAt='';
      this.lastError=error.code==='ENOENT'?'No Riot skin list was found. Connect to the internet once.':error.message;
      return false;
    }
  }
  async readManifest(file){
    const saved=JSON.parse(await readFile(file,'utf8'));
    if(saved.generatedAt===this.generatedAt&&this.ready){this.lastError='';this.applyNames();return true;}
    const skins=manifestSkins(saved);
    this.index({commit:`local-${Number(saved.converterRevision)||0}`,skins});
    this.generatedAt=typeof saved.generatedAt==='string'?saved.generatedAt:'';
    this.lastError='';
    return this.ready;
  }
  async forChampion(champion){return this.byChampion.get(champion)||NO_SKINS;}
  /** The same, at once: what is loaded now. */
  listed(champion){return this.byChampion.get(champion)||NO_SKINS;}
  /** A friend's skin, by the hash the catalogue lists for it. */
  async find(champion,sha){
    const skin=this.byBlob.get(`${champion}:${sha}`);
    return skin?this.ensure(champion,skin.id):null;
  }
  ensure(champion,id){
    const skin=(this.byChampion.get(champion)||[]).find(item=>item.id===id);
    if(!skin)return Promise.reject(new Error('This skin is not available in the Riot skin list.'));
    const key=`${champion}:${id}`,running=this.pending.get(key);
    if(running)return running;
    const work=this.ensureSkin(skin).finally(()=>this.pending.delete(key));
    this.pending.set(key,work);
    return work;
  }
  /** The package itself, built from the installed League for this skin. A selectable
   * form has no League skin slot, so its converted database package is its source. */
  async ensureSkin(skin){
    const options=isFormSkin(skin)?{archive:await this.formArchive(skin)}:undefined;
    const built=await this.buildSkin(skin,options);
    if(!built?.file)throw new Error('This Riot skin could not be built for the installed League.');
    return {...skin,file:built.file};
  }
  /**
   * A form's converted package, which the list carries only as a hash and path. It is
   * kept in this PC's database folder and downloaded from the same commit the list came
   * from when missing, so a friend can select Revenant Reign Viego's swords too.
   */
  async formArchive(skin){
    return await this.hasPackage(skin)?this.fileFor(skin):this.fetchPackage(skin);
  }
  /** True when this PC holds exactly the file the list names. */
  async hasPackage(skin){
    try{
      const file=this.fileFor(skin),info=await stat(file);
      return info.isFile()&&info.size===skin.size&&await gitBlobHash(file,skin.size)===skin.sha;
    }catch{return false;}
  }
  /** One file from the list's own commit, verified; a pick and the background download share a run. */
  fetchPackage(skin){
    const key=`${skin.relative}:${skin.sha}`,running=this.downloads.get(key);
    if(running)return running;
    const work=this.downloadPackage(skin).finally(()=>this.downloads.delete(key));
    this.downloads.set(key,work);
    return work;
  }
  async downloadPackage(skin){
    const file=this.fileFor(skin),revision=this.revision||DATABASE_BRANCH;
    let response;
    try{response=await this.fetchFn(rawFile(revision,skin.relative),{signal:AbortSignal.timeout(120000)});}
    catch{throw new Error('This appearance\'s package could not be downloaded. Check your connection and try again.');}
    if(!response.ok)throw Object.assign(new Error(`This appearance's package could not be downloaded (${response.status}). Try again in a moment.`),{status:response.status});
    const bytes=Buffer.from(await response.arrayBuffer());
    const sha=createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`),bytes])).digest('hex');
    if(bytes.length!==skin.size||sha!==skin.sha)throw new Error('The downloaded appearance did not match the Riot skin list.');
    await mkdir(path.dirname(file),{recursive:true});
    const temp=`${file}.${randomBytes(8).toString('hex')}.tmp`;
    try{
      await writeFile(temp,bytes,{flag:'wx'});
      await rename(temp,file);
    }finally{await unlink(temp).catch(()=>{});}
    return file;
  }
  /**
   * Queues every form file the list names that this PC lacks or has different, so a deleted
   * folder, an interrupted download, a changed list and a first list all end the same way.
   * Only forms: an ordinary skin is built from the installed League and has no file here.
   */
  async audit(){
    const result={checked:0,queued:0,skipped:false};
    if(!this.revision||!this.ready||this.localList||this.generatedAt!==this.agreedAt){result.skipped=true;return result;}
    for(const skin of this.skins().filter(isFormSkin)){
      result.checked++;
      if(this.waiting.has(skin.relative)||await this.hasPackage(skin))continue;
      this.waiting.add(skin.relative);result.queued++;
    }
    if(result.queued)await this.saveList().catch(()=>{});
    return result;
  }
  /**
   * Downloads the forms' files `audit` found missing or different. A match or a game stops it
   * first; what is left stays in `waiting` (also on disk) for the next call. Only one runs at a time.
   */
  fetchChanged({canContinue=async()=>true}={}){
    this.fetching??=this.fetchWaiting(canContinue).finally(()=>{this.fetching=null;});
    return this.fetching;
  }
  async fetchWaiting(canContinue){
    const result={downloaded:0,failed:0,missing:0,left:this.waiting.size,stopped:false,limited:false};
    if(!this.waiting.size||!this.revision)return result;
    const rows=new Map(this.skins().filter(isFormSkin).map(skin=>[skin.relative,skin])),wanted=[];
    for(const relative of [...this.waiting]){
      const skin=rows.get(relative);
      if(skin&&!await this.hasPackage(skin))wanted.push(skin);
      else this.waiting.delete(relative);
    }
    const total=wanted.reduce((sum,skin)=>sum+skin.size,0);
    let bytes=0,done=0;
    const report=()=>this.onProgress?.({what:'files',bytes,total,files:done,count:wanted.length});
    // A list that arrived meanwhile may want a newer file at this path, which must stay waiting.
    const finish=skin=>{if((this.byChampion.get(skin.champion)||[]).find(row=>row.relative===skin.relative)?.sha===skin.sha)this.waiting.delete(skin.relative);};
    if(wanted.length)report();
    for(let at=0;at<wanted.length;at+=FILES_AT_ONCE){
      if(!await canContinue()){result.stopped=true;break;}
      const files=wanted.slice(at,at+FILES_AT_ONCE);
      let failedHere=0;
      await Promise.all(files.map(async skin=>{
        try{
          await this.fetchPackage(skin);
          finish(skin);bytes+=skin.size;done++;result.downloaded++;report();
        }catch(error){
          // The list comes from this same commit, so a file it lacks will never arrive.
          if(error.status===404){finish(skin);result.missing++;return;}
          if(error.status===403||error.status===429)result.limited=true;
          failedHere++;result.failed++;
        }
      }));
      if(result.limited)break;
      if(failedHere===files.length){result.halted=true;break;}
    }
    await this.saveList().catch(()=>{});
    result.left=this.waiting.size;
    return result;
  }
  /**
   * Once on each PC (7.3): deletes the ordinary skins' files that earlier versions downloaded and
   * nothing reads. Forms, the list and the names stay. A match stops it; the next check carries on.
   */
  async removeUnused({canContinue=async()=>true}={}){
    const result={removed:0,stopped:false,skipped:false};
    if(this.cleaned||this.removing||!this.ready){result.skipped=true;return result;}
    this.removing=true;
    try{
      const folders=(await readdir(this.root,{withFileTypes:true})).filter(entry=>entry.isDirectory()&&/^\d+$/.test(entry.name));
      for(const folder of folders){
        if(!await canContinue()){result.stopped=true;return result;}
        result.removed+=await this.clearFolder(path.join(this.root,folder.name));
      }
      this.cleaned=true;
      await this.saveList().catch(()=>{});
      return result;
    }finally{this.removing=false;}
  }
  /** The skin files in one numbered folder and those under it; a folder left empty goes too. */
  async clearFolder(folder){
    const entries=await readdir(folder,{withFileTypes:true}).catch(()=>[]);
    let removed=0;
    for(let at=0;at<entries.length;at+=REMOVED_AT_ONCE)await Promise.all(entries.slice(at,at+REMOVED_AT_ONCE).map(async entry=>{
      const full=path.join(folder,entry.name);
      if(entry.isDirectory()){
        if(/^\d+$/.test(entry.name)){const inside=await this.clearFolder(full);removed+=inside;}
        return;
      }
      const number=fileNumber(entry.name);
      if(number===undefined||isFormSkin({id:Number(number)}))return;
      await unlink(full).then(()=>{removed++;},()=>{});
    }));
    await rmdir(folder).catch(()=>{});
    return removed;
  }
  /** Where a form's file lives on this PC. */
  fileFor(skin){return path.join(this.root,...skin.relative.split('/'));}
  async refreshNames(){
    const unnamed=this.skins().filter(skin=>!skin.name||PLACEHOLDER.test(skin.name));
    if(!unnamed.length)return false;
    if(this.namesFor===this.generatedAt&&unnamed.every(skin=>this.names.has(skin.id)))return false;
    try{
      const response=await this.fetchFn(NAMES_URL,{headers:this.namesEtag?{'If-None-Match':this.namesEtag}:{},signal:AbortSignal.timeout(60000)});
      if(response.status===304&&!this.names.size)this.namesEtag='';
      if(response.status!==304){
        if(!response.ok)throw new Error(`Riot's skin names could not be read (${response.status}).`);
        const names=skinNames(response.body&&this.onProgress
          ?JSON.parse((await readWithProgress(response,progress=>this.onProgress({what:'names',...progress}))).toString('utf8'))
          :await response.json());
        if(!names.size)throw new Error('Riot sent no skin names.');
        this.names=names;
        this.namesEtag=response.headers?.get?.('etag')||'';
      }
      this.namesFor=this.generatedAt;
      await this.saveNames();
    }catch{/* A number stays until the next check; never a reason to lose the list. */}
    this.applyNames();
    return true;
  }
  watchManifest(){
    if(this.watcher||!this.onChange)return;
    try{
      this.watcher=watch(this.root,{persistent:false},(_event,filename)=>{
        if(String(filename||'').toLowerCase()!==MANIFEST.toLowerCase())return;
        clearTimeout(this.watchTimer);
        this.watchTimer=setTimeout(()=>{void this.onChange();},250);
        this.watchTimer.unref?.();
      });
      this.watcher.on('error',()=>{this.watcher?.close();this.watcher=null;});
    }catch{/* The next startup or local check will retry. */}
  }
  close(){
    clearTimeout(this.watchTimer);
    this.watcher?.close();this.watcher=null;
  }
}
