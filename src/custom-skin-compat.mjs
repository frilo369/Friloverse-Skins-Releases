import {mkdir,readdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import yauzl from 'yauzl';
import {addWadFiles,readWadFile,readWadFileOnDisk,readWadHashesOnDisk,wadRows,writeWad,writeWadRows,writeZip} from './skin-slots.mjs';
import {xxh64} from './league-icons.mjs';
import {fileHash} from './git-blob.mjs';
import {baseSkinName,renameBaseSkin} from './bin-compat.mjs';
import {leagueBanks,leagueLocaleWads,moveAudioToBase} from './skin-audio.mjs';
import {fitShaders,SHADER_WAD} from './skin-shaders.mjs';
import {convertBinTypes,convertWadTypes} from './bin-types.mjs';
import {leagueWadNames,MODPKG,modpkgFiles,modpkgWadNames} from './modpkg.mjs';
import {readEntry} from './zip-entry.mjs';

const HEADER=272,ENTRY=32,MAX_PACKAGE=1024*1024*1024;
// 2: a copy keeps the skin's sounds on the base tag, where Repair would take them out.
// 3 (9.6): a skin's copy left out its shader WADs, which broke skins with a shader of their own.
// 4: a skin's shader WADs are fitted to the installed League instead (src/skin-shaders.mjs).
// 5 (9.8): properties League now reads in another type are converted in every BIN (src/bin-types.mjs).
// 6 (12.5): a custom skin's audio moves strictly onto the base slot (events, bank paths,
// localized VO), as LTK's in-game base-skin check refused Travis Scott Ekko's `ekkoSkin<n>` events.
// 7: a skin whose whole data sits in `<Champion>.<locale>.wad.client` moves to the main WAD.
export const COMPAT_REVISION=7;
export const sourceHash=file=>fileHash(file,'sha256');

/** Replace one member, retaining every other member's compressed bytes and metadata. */
export function replaceWadFile(wad,file,replacement){
  if(wad.length<HEADER||wad.toString('latin1',0,2)!=='RW'||wad[2]!==3)throw new Error('Unsupported WAD archive.');
  const count=wad.readUInt32LE(268),end=HEADER+count*ENTRY;
  if(end>wad.length)throw new Error('Incomplete WAD table.');
  const table=Buffer.from(wad.subarray(HEADER,end)),parts=[];
  const wanted=xxh64(file.toLowerCase());let offset=end,replaced=0;
  for(let at=0;at<table.length;at+=ENTRY){
    const start=table.readUInt32LE(at+8),length=table.readUInt32LE(at+12);
    if(start<end||start+length>wad.length)throw new Error('Incomplete WAD member.');
    let bytes=wad.subarray(start,start+length);
    if(table.readBigUInt64LE(at)===wanted){
      bytes=replacement;replaced++;
      table.writeUInt32LE(bytes.length,at+12);table.writeUInt32LE(bytes.length,at+16);
      table.fill(0,at+20,at+32);
    }
    table.writeUInt32LE(offset,at+8);offset+=bytes.length;parts.push(bytes);
  }
  if(replaced!==1)throw new Error('The base skin must occur exactly once in its WAD.');
  // A newly written mod WAD, like writeWad(): no stale signature/table checksum.
  const header=Buffer.alloc(HEADER);wad.copy(header,0,0,4);header.writeUInt32LE(count,268);
  return Buffer.concat([header,table,...parts]);
}

/** The WAD with these files in it, replaced where it has them already. */
export function putWadFiles(wad,files){
  for(const row of files)wad=readWadFile(wad,row.file)?replaceWadFile(wad,row.file,row.bytes):addWadFiles(wad,[row]);
  return wad;
}

export async function archiveFiles(file){
  const zip=await yauzl.openPromise(file,{autoClose:false,validateEntrySizes:true}),files=[];
  let total=0;
  try{
    for await(const entry of zip.eachEntry()){
      if(entry.fileName.endsWith('/'))continue;
      total+=entry.uncompressedSize;
      if(total>MAX_PACKAGE||files.length>=65535)throw new Error('The custom skin archive is too large.');
      files.push({name:entry.fileName.replaceAll('\\','/'),bytes:await readEntry(zip,entry)});
    }
  }finally{zip.close();}
  return files;
}

/** The files of a skin package: a Fantome's, or a .modpkg read as a Fantome's (src/modpkg.mjs). */
export async function packageFiles(file,league){
  return MODPKG.test(file)?modpkgFiles(file,{names:league?await leagueWadNames(league):null}):archiveFiles(file);
}

/** Does this archive ship League shader WADs? Reads only its list of files. */
export async function hasShaderWads(file){
  if(MODPKG.test(file))return (await modpkgWadNames(file)).some(name=>SHADER_WAD.test(`wad/${name}`));
  const zip=await yauzl.openPromise(file,{autoClose:false});
  try{for await(const entry of zip.eachEntry())if(SHADER_WAD.test(entry.fileName.replaceAll('\\','/')))return true;}
  finally{zip.close();}
  return false;
}

/**
 * Some packages (Rick Sanchez Viktor, Albedo Morgana) hold the whole skin (skin bins, models,
 * textures, animations) in `<Champion>.<locale>.wad.client` and no `<Champion>.wad.client` at all.
 * LTK still routes the new chunks to the main WAD, but Friloverse looked for the champion's data
 * only in the main WAD: it found no `skin0.bin`, moved no audio, and built the picked slot from
 * League's own base skin instead of the skin's, so the base champion drew.
 *
 * Such a WAD is split the way LTK routes it: files League's own locale WAD also has stay in the
 * locale WAD, every other file goes to a main WAD named as League spells it.
 */
export async function moveChampionDataToMainWad(files,{champion,league}){
  const alias=String(champion||'').toLowerCase();
  if(!alias||!/^[a-z0-9]+$/.test(alias))return files;
  const main=`wad/${alias}.wad.client`,inside=`data/characters/${alias}/skins/skin0.bin`;
  if(files.some(row=>{const name=row.name.toLowerCase();return name===main||name.startsWith(`${main}/`);}))return files;
  const locale=new RegExp(`^wad/${alias}\\.([a-z]{2}_[a-z]{2})\\.wad\\.client$`,'i');
  const holder=files.find(row=>locale.test(row.name)&&readWadFile(row.bytes,inside));
  if(!holder)return files;
  const folder=path.join(league,'Game','DATA','FINAL','Champions');
  const leagueName=async wanted=>(await readdir(folder).catch(()=>[])).find(name=>name.toLowerCase()===wanted)||null;
  const rows=wadRows(holder.bytes);
  const lang=locale.exec(holder.name)[1];
  const localeName=await leagueName(`${alias}.${lang.toLowerCase()}.wad.client`);
  const theirs=localeName?await readWadHashesOnDisk(path.join(folder,localeName),rows.map(row=>row.hash)):null;
  const stay=rows.filter(row=>theirs?.has(row.hash)),move=rows.filter(row=>!theirs?.has(row.hash));
  const mainName=await leagueName(main.slice(4))||`${champion}.wad.client`;
  const out=[];
  for(const row of files){
    if(row!==holder){out.push(row);continue;}
    out.push({name:`WAD/${mainName}`,bytes:writeWadRows(holder.bytes,move)});
    if(stay.length)out.push({name:`WAD/${localeName}`,bytes:writeWadRows(holder.bytes,stay)});
  }
  return out;
}

/** A separate deterministic working copy; the original archive is never written. */
export async function buildCustomSkinCopy({file,champion,dir,league}){
  const hash=await sourceHash(file),alias=champion?String(champion).toLowerCase():'';
  if(alias&&!/^[a-z0-9]+$/.test(alias))throw new Error('Invalid champion name.');
  const inside=`data/characters/${alias}/skins/skin0.bin`;
  const insideHash=alias?`${xxh64(inside).toString(16).padStart(16,'0')}.`:'';
  const base=alias?await readWadFileOnDisk(path.join(league,'Game','DATA','FINAL','Champions',`${champion}.wad.client`),inside):null;
  const baseName=base&&baseSkinName(base,alias);
  if(alias&&!baseName)throw new Error(`League's base skin name for ${champion} could not be read.`);
  let files=await moveChampionDataToMainWad(await packageFiles(file,league),{champion,league}),renamed=false;
  const shaders=!!alias&&files.some(row=>SHADER_WAD.test(row.name));
  if(shaders)files=await fitShaders(files,league);
  const convert=bytes=>{
    const current=baseSkinName(bytes,alias);
    const match=current&&new RegExp(`^${alias}skin(\\d+)$`,'i').exec(current);
    return match&&Number(match[1])>0?renameBaseSkin(bytes,alias,baseName):null;
  };
  const modLocalePattern=alias?new RegExp(`^wad/${alias}\\.([a-z]{2}_[a-z]{2})\\.wad\\.client$`,'i'):null;
  const modLocaleWads=modLocalePattern?files.filter(item=>modLocalePattern.test(item.name)):[];
  const readLocaleMod=target=>{
    for(const item of modLocaleWads){
      const direct=readWadFile(item.bytes,target);
      if(direct)return direct;
      const lang=item.name.match(modLocalePattern)?.[1];
      if(lang){
        const swapped=target.replace(/\/vo\/[a-z]{2}_[a-z]{2}\//i,`/VO/${lang}/`);
        const found=readWadFile(item.bytes,swapped);
        if(found)return found;
      }
    }
    return null;
  };
  // LTK's in-game base-skin check rejects skin0 when SkinAudioProperties names another skin
  // (tags, bank unit names, bank paths or events), and then turns off the whole overlay. The
  // skin's audio moves strictly onto the base slot, keeping its own and localized VO banks.
  // Its model is never altered: a model that is another skin's mesh stays refused by LTK.
  const fromLeague=alias?leagueBanks(league,champion):null;
  const prepareSkin0=async(bytes,readLocal)=>{
    const converted=convert(bytes);
    if(converted)renamed=true;
    let next=converted||bytes;
    const modProvided=new Set();
    const readBank=async target=>{
      const own=readLocal(target)||readLocaleMod(target);
      if(own){modProvided.add(target.toLowerCase());return own;}
      return fromLeague(target);
    };
    const audio=await moveAudioToBase({bytes:next,alias,base,read:readBank,strictBase:true});
    next=audio.bytes;
    const addedFiles=[...audio.files];
    const localeWads=audio.localeFiles.length?await leagueLocaleWads(league,champion,audio.localeFiles,{customSources:modProvided}):[];
    for(const {wadName,files:localized} of localeWads){
      const targetName=`wad/${wadName.toLowerCase()}`;
      const existing=files.find(item=>item.name.toLowerCase()===targetName);
      if(existing)existing.bytes=putWadFiles(existing.bytes,localized);
      else files.push({name:`WAD/${wadName}`,bytes:writeWad(localized)});
    }
    for(const entry of audio.localeFiles){
      // The skin's own voice banks also stay in its main WAD, where it shipped them: a stale
      // bank the skin keeps at the base path there (Iron Darius) would otherwise answer first.
      if(modProvided.has(entry.source.toLowerCase())||readLocal(entry.file))addedFiles.push({file:entry.file,bytes:entry.bytes});
    }
    return {bytes:next,files:addedFiles};
  };
  for(const row of alias?[...files]:[]){
    const name=row.name.toLowerCase();
    if(name===`wad/${alias}.wad.client`){
      const bytes=readWadFile(row.bytes,inside);
      if(!bytes)continue;
      const prepared=await prepareSkin0(bytes,target=>readWadFile(row.bytes,target));
      if(prepared.bytes!==bytes||prepared.files.length){
        const updated=prepared.bytes!==bytes?replaceWadFile(row.bytes,inside,prepared.bytes):row.bytes;
        row.bytes=prepared.files.length?putWadFiles(updated,prepared.files):updated;
      }
    }else if(name===`wad/${alias}.wad.client/${inside}`||name.startsWith(`wad/${alias}.wad.client/${insideHash}`)){
      // The WAD as a folder of loose files (named or hashed).
      const folder=row.name.slice(0,row.name.indexOf('/',4)+1);
      // Tools also save a file under its hash, and one WAD path must not arrive twice.
      const loose=target=>{
        const named=`${folder}${target}`.toLowerCase(),hashed=`${folder}${xxh64(target.toLowerCase()).toString(16).padStart(16,'0')}.`.toLowerCase();
        return files.find(item=>{const itemName=item.name.toLowerCase();return itemName===named||itemName.startsWith(hashed);});
      };
      const prepared=await prepareSkin0(row.bytes,target=>loose(target)?.bytes||null);
      row.bytes=prepared.bytes;
      for(const extra of prepared.files){
        const present=loose(extra.file);
        if(present)present.bytes=extra.bytes;
        else files.push({name:`${folder}${extra.file}`,bytes:extra.bytes});
      }
    }
  }
  let info=files.find(row=>row.name.toLowerCase()==='meta/info.json');
  if(!info){
    // Community .zip packs sometimes omit META/info.json while shipping valid WAD/ data.
    if(!files.some(row=>row.name.toLowerCase().startsWith('wad/')))throw new Error('The skin has no Fantome metadata.');
    const fallbackName=path.basename(file).replace(/\.(?:fantome|modpkg|zip)$/i,'')||'Custom skin';
    info={name:'META/info.json',bytes:Buffer.from(JSON.stringify({Name:fallbackName,Author:'Unknown',Version:'1.0.0',Description:''}),'utf8')};
    files.push(info);
  }
  const metadata=JSON.parse(info.bytes.toString('utf8').replace(/^\uFEFF/,''));
  // Properties League now reads in another type, in every BIN, named or not (src/bin-types.mjs).
  // The skin's own names let text saved as a hash be written out again.
  const names=[metadata.Name,path.basename(file).replace(/\.(?:fantome|modpkg)$/i,'')].filter(text=>typeof text==='string');
  let converted=0;
  for(const row of files){
    const name=row.name.toLowerCase();
    if(/^wad\/[^/]+\.wad\.client$/.test(name)){
      let result=null;
      try{result=convertWadTypes(row.bytes,{names});}catch{/* A WAD this cannot read is left to LTK. */}
      if(result){row.bytes=result.wad;converted+=result.changed;}
    }else if(/^wad\/[^/]+\.wad\.client\//.test(name)){
      const result=convertBinTypes(row.bytes,{names});
      if(result){row.bytes=result.bytes;converted+=result.changed;}
    }
  }
  metadata.Name=`Friloverse prepared ${champion||'mod'} ${hash.slice(0,16)}`;
  info.bytes=Buffer.from(JSON.stringify(metadata),'utf8');
  await mkdir(dir,{recursive:true});
  const output=path.join(dir,`${alias||'mod'}-${hash.slice(0,16)}.fantome`);
  await writeFile(output,writeZip(files));
  return {file:output,sourceHash:hash,renamed,baseName,shaders,converted};
}
