import {randomBytes} from 'node:crypto';
import {mkdir,readFile,rename,rm,stat,unlink,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {leagueFolder} from './league-client.mjs';
import {addWadFiles,binHash,parseBin,readWadFile,readWadFilesOnDisk,writeBin,writeWad,writeZip} from './skin-slots.mjs';
import {archiveFiles,putWadFiles,replaceWadFile} from './custom-skin-compat.mjs';
import {baseSkinName,bodyMeshPaths,meshPairs,renameBaseSkin,useBaseSkinMesh} from './bin-compat.mjs';
import {rebuildMesh} from './mesh-rebuild.mjs';
import {leagueBanks,leagueLocaleWads,moveAudioToBase} from './skin-audio.mjs';
import {isFormSkin} from './fryilo-catalog/catalog.mjs';
import {KIND,field,objectFields,structFields} from './bin-values.mjs';

// The catalogue names a skin by its number. This builds the package the way Rose's
// library does: the chosen skin's own data object moves onto the base skin's slot, under
// the base skin's name, and the skin's rebuilt model files (an unused null joint and
// vertex) are written at the base skin's paths. LTK Manager's base-skin check then sees a
// distinct model and the game draws the chosen one. Everything comes from the installed
// League, so no download is needed.
const VERSION=14;

const plain=message=>Object.assign(new Error(message),{plain:true});

let champions=null;
const extraChampions=new Map();
/** Register day-0 champions discovered from the local League install so builds work before an app update. */
export function registerChampions(list){
  if(!Array.isArray(list))return;
  for(const row of list){
    const key=Number(row?.key);
    if(Number.isSafeInteger(key)&&key>0&&typeof row?.id==='string'&&row.id)extraChampions.set(key,row.id);
  }
}
/** The champion's internal name (`Ahri`), which its archives and BINs are named by. */
async function aliasFor(champion){
  champions ??= JSON.parse(await readFile(new URL('./ui/champions.json',import.meta.url),'utf8'));
  return champions.find(row=>Number(row.key)===Number(champion))?.id||extraChampions.get(Number(champion))||null;
}


const GEAR_SKIN_UPGRADE=binHash('GearSkinUpgrade');

/**
 * 12.6: the effects of a skin whose starting look is its first gear. DJ Sona Ultimate Remix
 * (37077) draws Genre1 and its first gear is that same Genre1 model; the gear's effect map
 * holds what the skin's own map leaves empty (Q zone, power-chord-ready rings, idle, recall,
 * its own basic attacks). In a real game `SonaSkin77Manager` equips that gear, but the
 * server gives the manager only to a player whose skin number really is 77, so a skin on
 * the base slot never gets it. The gear's entries are written into the skin's own map
 * (the gear's value wins, as it does in game; an empty gear value never removes one) and
 * the skin's `mResourceResolver` is pointed at that map on the base slot. Null when the
 * skin has no such gear, so every other skin's bytes stay exactly as authored.
 */
export function startingGearEffects(objects,{skin,resources,targetResources}){
  try{
    const skinFields=objectFields(skin.body);
    const first=field(structFields(field(skinFields,'skinUpgradeData')),'mGearSkinUpgrades')?.value?.[0];
    if(first?.kind!==KIND.LINK)return null;
    const gear=objects.find(object=>object.hash===first.value&&object.type===GEAR_SKIN_UPGRADE);
    if(!gear)return null;
    const gearData=structFields(field(objectFields(gear.body),'mGearData'));
    const model=list=>String(field(structFields(field(list,'skinMeshProperties')),'simpleSkin')?.value||'').toLowerCase();
    if(!model(skinFields)||model(gearData)!==model(skinFields))return null;
    const gearMap=field(structFields(field(gearData,'mVfxResourceResolver')),'resourceMap');
    const map=field(objectFields(resources.body),'resourceMap'),link=field(skinFields,'mResourceResolver');
    const hashToLink=value=>value?.kind===KIND.MAP&&value.value.key===KIND.HASH&&value.value.item===KIND.LINK;
    if(!hashToLink(gearMap)||!hashToLink(map)||link?.kind!==KIND.LINK)return null;
    const merged=new Map(map.value.entries.map(([key,value])=>[key.value,value.value]));
    let added=0;
    for(const [key,value] of gearMap.value.entries){
      if(!value.value||merged.get(key.value)===value.value)continue;
      merged.set(key.value,value.value);added++;
    }
    if(!added)return null;
    const entries=Buffer.alloc(merged.size*8);
    let at=0;
    for(const [key,value] of merged){entries.writeUInt32LE(key,at);entries.writeUInt32LE(value,at+4);at+=8;}
    const head=Buffer.alloc(10);
    head[0]=KIND.HASH;head[1]=KIND.LINK;head.writeUInt32LE(entries.length+4,2);head.writeUInt32LE(merged.size,6);
    // resourceMap is a top-level field: only the object's own length changes, which writeBin takes from the body.
    const resolverBody=Buffer.concat([resources.body.subarray(0,map.start),head,entries,resources.body.subarray(map.end)]);
    const skinBody=Buffer.from(skin.body);
    skinBody.writeUInt32LE(targetResources,link.start);
    return {skinBody,resolverBody,added};
  }catch{return null;/* A shape this cannot read is left as authored. */}
}

/** The skin's own two objects (skin data + resource resolver), re-keyed onto the base slot. */
function skinObjectsBin({alias,champion,number,skin}){
  const parsed=parseBin(skin);
  if(!parsed)throw plain('This skin\'s data could not be read from the installed League.');
  const source=binHash(`characters/${alias}/skins/skin${number}`);
  const sourceResources=binHash(`characters/${alias}/skins/skin${number}/resources`);
  const target=binHash(`characters/${alias}/skins/skin0`);
  const targetResources=binHash(`characters/${alias}/skins/skin0/resources`);
  const objects=parsed.objects
    .filter(object=>object.hash===source||object.hash===sourceResources)
    .map(object=>{
      // An object's hash is the first four bytes of its body in this format. Only that
      // key moves to the base slot; the skin's own values stay as authored, which is
      // what Rose's packages carry.
      const body=Buffer.from(object.body);
      body.writeUInt32LE(object.hash===source?target:targetResources,0);
      return {type:object.type,hash:body.readUInt32LE(0),body};
    });
  if(objects.length!==2)throw plain('This skin\'s data has an unexpected shape.');
  const skinObject=objects.find(object=>object.hash===target),resources=objects.find(object=>object.hash===targetResources);
  const gear=skinObject&&resources&&startingGearEffects(parsed.objects,{skin:skinObject,resources,targetResources});
  if(gear){skinObject.body=gear.skinBody;resources.body=gear.resolverBody;}
  // The dependency keeps the skin's own animations and effects, which the base skin lacks.
  return writeBin({version:parsed.version,dependencies:[`DATA/Characters/${champion}/Skins/Skin${number}.bin`],objects,tail:parsed.tail});
}

/** The chosen skin's own object, on the base skin's slot and under its name and model. */
export function buildSkinBin({alias,champion,number,skin,base,name}){
  const onBase=skinObjectsBin({alias,champion,number,skin});
  const pairs=meshPairs(onBase,base,alias,{lenient:true});
  if(!pairs)throw plain('This skin\'s model could not be mapped onto the base skin.');
  // The skin's own body models must all be moved; a chroma's extra particle models may
  // stay where the game already has them, but the base body cannot be left unnamed.
  const mapped=new Set(pairs.map(([from])=>from.toLowerCase()));
  for(const model of bodyMeshPaths(onBase,alias))if(!mapped.has(model.toLowerCase()))throw plain('This skin\'s model could not be mapped onto the base skin.');
  const meshed=useBaseSkinMesh(onBase,alias,base,{lenient:true});
  if(!meshed)throw plain('This skin\'s model could not be mapped onto the base skin.');
  const bytes=renameBaseSkin(meshed,alias,name)||meshed;
  if(baseSkinName(bytes,alias)!==name)throw plain('The built skin did not take the base skin\'s name.');
  return bytes;
}

/**
 * A handcrafted form's own data, moved onto the base skin's name and model. Its package
 * already puts the object on the base slot, so nothing is re-keyed; `sourceForModels`
 * is the BIN whose mesh paths name the real model, taken from League when the package
 * was already converted.
 */
export function buildFormSkinBin({alias,champion,bytes,base,parent,name}){
  if(!parseBin(bytes)||!baseSkinName(bytes,alias))throw plain('This appearance\'s data could not be read from its package.');
  const sourceForModels=baseSkinName(bytes,alias)===name?parent:bytes;
  if(baseSkinName(bytes,alias)!==name){
    const rebased=useBaseSkinMesh(bytes,alias,base,{lenient:true});
    if(!rebased)throw plain('This appearance\'s model could not be mapped onto the base skin.');
    bytes=rebased;
  }
  bytes=renameBaseSkin(bytes,alias,name)||bytes;
  if(baseSkinName(bytes,alias)!==name)throw plain('The built appearance did not take the base skin\'s name.');
  return {bytes,sourceForModels};
}

/** Builds one Riot skin package from the installed League, kept for the session. */
export class RiotSkinBuilder{
  constructor({cacheDir,league=leagueFolder,version=VERSION}={}){
    if(!cacheDir)throw new Error('A cache folder is required to build Riot skins.');
    this.cacheDir=cacheDir;this.league=league;this.version=version;
  }
  /** Built copies are regenerable; a new run never needs an old one. */
  async clean(){
    await rm(this.cacheDir,{recursive:true,force:true}).catch(()=>{});
  }
  async build(skin,options={}){
    if(isFormSkin(skin))return this.buildForm(skin,options);
    const champion=await aliasFor(skin?.champion);
    if(!champion)throw plain('This champion is not in Friloverse\'s champion list.');
    const number=Number(skin.id)%1000;
    if(!Number.isInteger(number)||number<0||number>999)throw plain('This skin has an unexpected number.');
    const alias=champion.toLowerCase();
    const wadFile=path.join(await this.league(),'Game','DATA','FINAL','Champions',`${champion}.wad.client`);
    const cacheFile=path.join(this.cacheDir,`${alias}-${number}-${String(skin.sha||'').slice(0,12)}-v${this.version}.fantome`);
    // A patch rewrites the champion's WAD; a build made before it must not be reused.
    const [cached,wadInfo]=await Promise.all([stat(cacheFile).catch(()=>null),stat(wadFile).catch(()=>null)]);
    if(cached&&wadInfo&&cached.isFile()&&cached.size>0&&cached.mtimeMs>=wadInfo.mtimeMs)return {file:cacheFile,bytes:await readFile(cacheFile)};
    const basePath=`data/characters/${alias}/skins/skin0.bin`,skinPath=`data/characters/${alias}/skins/skin${number}.bin`;
    let members;
    try{members=await readWadFilesOnDisk(wadFile,[basePath,skinPath]);}
    catch{throw plain('The installed League files could not be read.');}
    const base=members.get(basePath),target=members.get(skinPath);
    if(!base||!target)throw plain('This skin is not part of the installed League version.');
    const name=baseSkinName(base,alias);
    if(!name)throw plain('League\'s base skin data for this champion could not be read.');
    const leagueFiles=await this.league();
    const onBase=skinObjectsBin({alias,champion,number,skin:target});
    const audio=await moveAudioToBase({bytes:buildSkinBin({alias,champion,number,skin:target,base,name}),alias,base,read:leagueBanks(leagueFiles,champion),strictBase:true});
    // Map only the meshes referenced by skin0 itself, never secondary form/gear/particle
    // objects elsewhere in skinN.bin (e.g. DJ Sona's Genre2/Genre3 overwriting Genre1).
    const pairs=meshPairs(onBase,base,alias,{lenient:true});
    // Some recolours reference the base model itself: nothing to copy, the skin's own
    // data still carries its textures.
    if(!pairs)throw plain('This skin\'s model could not be mapped onto the base skin.');
    let models;
    try{models=await readWadFilesOnDisk(wadFile,pairs.map(([from])=>from));}
    catch{throw plain('The installed League files could not be read.');}
    const files=[{file:basePath,bytes:audio.bytes},...audio.files];
    const written=new Set();
    for(const [from,to] of pairs){
      const key=to.toLowerCase();
      if(written.has(key))continue;
      const model=models.get(from);
      if(!model)throw plain('This skin\'s model files are missing from the installed League.');
      // The rebuilt model is byte-distinct from the game's but draws the same (an unused
      // null joint/vertex). LTK's in-game base-skin check refuses the game's own bytes as
      // "one of the champion's other skins' meshes"; this is the same rebuild Rose ships.
      written.add(key);
      files.push({file:to,bytes:rebuildMesh(model)});
    }
    const localeWads=await leagueLocaleWads(leagueFiles,champion,audio.localeFiles);
    const info={Name:String(skin.name||name),Author:'Friloverse',Version:'1.0.0',Description:'Built from the installed League files.'};
    const archive=writeZip([
      {name:'META/info.json',bytes:Buffer.from(JSON.stringify(info),'utf8')},
      {name:`WAD/${champion}.wad.client`,bytes:writeWad(files)},
      ...localeWads.map(({wadName,files:localized})=>({name:`WAD/${wadName}`,bytes:writeWad(localized)})),
    ]);
    await mkdir(this.cacheDir,{recursive:true});
    const temp=`${cacheFile}.${randomBytes(6).toString('hex')}.tmp`;
    try{
      await writeFile(temp,archive,{flag:'wx'});
      await rename(temp,cacheFile);
    }finally{await unlink(temp).catch(()=>{});}
    return {file:cacheFile,bytes:archive};
  }
  /**
   * A selectable form whose data is not a League skin slot. Its converted database
   * package supplies the handcrafted data object and any extra files (audio banks, the
   * form controller); the installed League supplies the model at the base skin's paths.
   */
  async buildForm(skin,{archive}={}){
    if(!archive||!path.isAbsolute(archive))throw plain('This appearance needs its package from the local Riot skin database.');
    const champion=await aliasFor(skin?.champion);
    if(!champion)throw plain('This champion is not in Friloverse\'s champion list.');
    const parent=Number(skin.parent);
    const parentNumber=parent%1000;
    if(!Number.isSafeInteger(parent)||parent<1||!Number.isInteger(parentNumber)||parentNumber<1||parentNumber>999)throw plain('This appearance has no parent skin in the Riot list.');
    const formNumber=Number(skin.id)%1000,alias=champion.toLowerCase();
    const wadFile=path.join(await this.league(),'Game','DATA','FINAL','Champions',`${champion}.wad.client`);
    const cacheFile=path.join(this.cacheDir,`${alias}-${formNumber}-form-${String(skin.sha||'').slice(0,12)}-v${this.version}.fantome`);
    const [cached,wadInfo,archiveInfo]=await Promise.all([stat(cacheFile).catch(()=>null),stat(wadFile).catch(()=>null),stat(archive).catch(()=>null)]);
    if(!wadInfo||!archiveInfo?.isFile())throw plain('This appearance\'s package could not be read, or League is not installed.');
    if(cached&&cached.isFile()&&cached.size>0&&cached.mtimeMs>=Math.max(wadInfo.mtimeMs,archiveInfo.mtimeMs))return {file:cacheFile,bytes:await readFile(cacheFile)};
    let files;
    try{files=await archiveFiles(archive);}
    catch{throw plain('This appearance\'s package could not be read.');}
    const wadRow=files.find(row=>row.name.replaceAll('\\','/').toLowerCase()===`wad/${alias}.wad.client`);
    if(!wadRow)throw plain('This appearance\'s package has no champion data.');
    const inside=`data/characters/${alias}/skins/skin0.bin`,parentPath=`data/characters/${alias}/skins/skin${parentNumber}.bin`;
    const formBin=readWadFile(wadRow.bytes,inside);
    let members;
    try{members=await readWadFilesOnDisk(wadFile,[inside,parentPath]);}
    catch{throw plain('The installed League files could not be read.');}
    const base=members.get(inside),parentBin=members.get(parentPath);
    if(!formBin||!base||!parentBin)throw plain('This appearance\'s data or League\'s copy of it is missing.');
    const name=baseSkinName(base,alias);
    if(!name)throw plain('League\'s base skin data for this champion could not be read.');
    const built=buildFormSkinBin({alias,champion,bytes:formBin,base,parent:parentBin,name});
    const leagueFiles=await this.league();
    // The package's own banks come first: a form's sounds can be handcrafted.
    const fromLeague=leagueBanks(leagueFiles,champion);
    const audio=await moveAudioToBase({bytes:built.bytes,alias,base,read:async file=>readWadFile(wadRow.bytes,file)||fromLeague(file),strictBase:true});
    const modelSource=built.sourceForModels===parentBin?skinObjectsBin({alias,champion,number:parentNumber,skin:parentBin}):built.sourceForModels;
    const pairs=meshPairs(modelSource,base,alias,{lenient:true});
    if(!pairs)throw plain('This appearance\'s model could not be mapped onto the base skin.');
    let models;
    try{models=await readWadFilesOnDisk(wadFile,pairs.map(([from])=>from));}
    catch{throw plain('The installed League files could not be read.');}
    const added=[],written=new Set();
    for(const [from,to] of pairs){
      const key=to.toLowerCase();
      if(written.has(key))continue;
      const model=models.get(from);
      if(!model)throw plain('This appearance\'s model files are missing from the installed League.');
      written.add(key);
      added.push({file:to,bytes:rebuildMesh(model)});
    }
    wadRow.bytes=addWadFiles(putWadFiles(replaceWadFile(wadRow.bytes,inside,audio.bytes),audio.files),added);
    for(const {wadName,files:localized} of await leagueLocaleWads(leagueFiles,champion,audio.localeFiles)){
      const existing=files.find(row=>row.name.replaceAll('\\','/').toLowerCase()===`wad/${wadName.toLowerCase()}`);
      if(existing)existing.bytes=putWadFiles(existing.bytes,localized);
      else files.push({name:`WAD/${wadName}`,bytes:writeWad(localized)});
    }
    const bytes=writeZip(files);
    await mkdir(this.cacheDir,{recursive:true});
    const temp=`${cacheFile}.${randomBytes(6).toString('hex')}.tmp`;
    try{
      await writeFile(temp,bytes,{flag:'wx'});
      await rename(temp,cacheFile);
    }finally{await unlink(temp).catch(()=>{});}
    return {file:cacheFile,bytes};
  }
}
