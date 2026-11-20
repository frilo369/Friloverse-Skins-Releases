import {createHash,randomBytes} from 'node:crypto';
import {mkdir,open,readdir,rename,stat,unlink,writeFile} from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import yauzl from 'yauzl';
import {xxh64} from './league-icons.mjs';
import {fileHash} from './git-blob.mjs';
import {leagueFolder} from './league-client.mjs';
import {subcharactersOf} from './champion-subcharacters.mjs';
import {readEntry} from './zip-entry.mjs';

// League loads the file of the skin selected in its client, `skinN.bin`, not the `skin0.bin`
// a skin package replaces. FrYiLoCo's answer, in `overlay_content.rs`: the same file again at
// that number, with its two top-level keys changed from Skin0 to SkinN. In Friloverse that copy
// is a small mod of its own beside the original, which stays installed, so LTK Manager's
// checks of the original still decide everything: a refused skin never gets a copy.
const WAD_HEADER=272,WAD_ENTRY=32;
// DJ Sona's MUS_audio.wpk music banks reach ~85 MB uncompressed in Sona.wad.client.
const MAX_BIN=128*1024*1024,MAX_ARCHIVE_WAD=1024*1024*1024;
const BACKSLASH=String.fromCharCode(92);
const ZSTD_MAGIC=Buffer.from([0x28,0xb5,0x2f,0xfd]);

/** FNV-1a of the lower-case text: how BIN files name their objects. */
export function binHash(text){
  let hash=0x811c9dc5;
  for(const byte of Buffer.from(String(text).toLowerCase(),'utf8'))hash=Math.imul(hash^byte,0x01000193)>>>0;
  return hash;
}
const wadHash=text=>xxh64(String(text).toLowerCase());
const u32=value=>{const out=Buffer.alloc(4);out.writeUInt32LE(value>>>0);return out;};
const skinFile=(champion,slot)=>`data/characters/${champion}/skins/skin${slot}.bin`;

/** A property BIN by its top level. Every object says how long it is, so none is decoded. */
export function parseBin(bytes){
  // Skip a 12-byte PTCH patch-BIN header if present.
  let offset=0;
  if(bytes.length>=24&&bytes.toString('latin1',0,4)==='PTCH'&&bytes.toString('latin1',12,16)==='PROP')offset=12;
  if(bytes.length<offset+12||bytes.toString('latin1',offset,offset+4)!=='PROP')return null;
  const version=bytes.readUInt32LE(offset+4);
  if(version<1||version>3)return null;
  let at=offset+8;
  const dependencies=[];
  if(version>=2){
    const count=bytes.readUInt32LE(at);at+=4;
    for(let i=0;i<count;i++){
      const size=bytes.readUInt16LE(at);
      dependencies.push(bytes.toString('utf8',at+2,at+2+size));
      at+=2+size;
    }
  }
  const count=bytes.readUInt32LE(at);at+=4;
  const classes=[];
  for(let i=0;i<count;i++){classes.push(bytes.readUInt32LE(at));at+=4;}
  const objects=[];
  for(const type of classes){
    const size=bytes.readUInt32LE(at);
    if(size<4||at+4+size>bytes.length)return null;
    objects.push({type,hash:bytes.readUInt32LE(at+4),body:bytes.subarray(at+4,at+4+size)});
    at+=4+size;
  }
  return {version,dependencies,objects,tail:bytes.subarray(at)};
}
/** The same top-level layout back to bytes; every length comes from the bodies. */
export function writeBin({version,dependencies,objects,tail}){
  const parts=[Buffer.from('PROP','latin1'),u32(version)];
  if(version>=2){
    parts.push(u32(dependencies.length));
    for(const dependency of dependencies){
      const text=Buffer.from(dependency,'utf8'),size=Buffer.alloc(2);
      size.writeUInt16LE(text.length);parts.push(size,text);
    }
  }
  parts.push(u32(objects.length));
  for(const {type} of objects)parts.push(u32(type));
  for(const {body} of objects)parts.push(u32(body.length),body);
  parts.push(tail);
  return Buffer.concat(parts);
}
/** The same bytes with one 4-byte key swapped for another, wherever it is used. */
function swapKeys(bytes,swaps){
  const out=Buffer.from(bytes);
  for(const [from,to] of swaps){
    const needle=u32(from),replacement=u32(to);
    for(let at=out.indexOf(needle);at>=0;at=out.indexOf(needle,at+4))replacement.copy(out,at);
  }
  return out;
}
const normalized=file=>file.replaceAll('\\','/').toLowerCase();

/**
 * This champion's `skin0.bin` re-keyed for `slot`, or null when it is not one to move. When
 * the skin links the very file it is taking the place of (a chroma of the selected skin), that
 * link would point at itself, so the game's original is taken in: `original` reads it.
 */
export async function retargetBin(bytes,champion,slot,original=async()=>null){
  if(!Number.isInteger(slot)||slot<1||slot>999)return null;
  const bin=parseBin(bytes);
  if(!bin)return null;
  const prefix=`characters/${champion}/skins/skin`;
  const source=binHash(`${prefix}0`),sourceResources=binHash(`${prefix}0/resources`);
  const target=binHash(`${prefix}${slot}`),targetResources=binHash(`${prefix}${slot}/resources`);
  const skin=bin.objects.find(object=>object.hash===source);
  const resources=bin.objects.find(object=>object.hash===sourceResources);
  if(skin?.type!==binHash('SkinCharacterDataProperties')||resources?.type!==binHash('ResourceResolver'))return null;
  if(bin.objects.some(object=>object.hash===target||object.hash===targetResources))return null;
  const usedTargetResources=skin.body.includes(u32(targetResources));
  const swaps=[[source,target],[sourceResources,targetResources]];
  let objects=bin.objects.map(object=>({type:object.type,hash:object.hash===source?target:object.hash===sourceResources?targetResources:object.hash,body:swapKeys(object.body,swaps)}));
  let dependencies=[...bin.dependencies];
  const self=skinFile(champion,slot);
  if(dependencies.some(file=>normalized(file)===self)){
    const game=parseBin(await original(self)||Buffer.alloc(0));
    if(!game)return null;
    for(const object of game.objects){
      const present=objects.findIndex(row=>row.hash===object.hash);
      if(present<0)objects.push(object);
      else if(object.hash===targetResources&&usedTargetResources)objects[present]=object;
    }
    for(const file of game.dependencies)if(!dependencies.some(row=>row.toLowerCase()===file.toLowerCase()))dependencies.push(file);
    dependencies=dependencies.filter(file=>normalized(file)!==self);
  }
  return writeBin({...bin,dependencies,objects,tail:swapKeys(bin.tail,swaps)});
}

// Not a binary search: plenty of skins were packed by tools that leave these out of order.
function findEntry(table,hash){
  for(let at=0;at+WAD_ENTRY<=table.length;at+=WAD_ENTRY){
    if(table.readBigUInt64LE(at)===hash)return {offset:table.readUInt32LE(at+8),compressed:table.readUInt32LE(at+12),size:table.readUInt32LE(at+16),kind:table[at+20]&15};
  }
  return null;
}
/** Decompress a type-4 chunked WAD entry that may interleave zstd frames and raw sub-chunks. */
function decompressChunked(raw,size){
  if(!zlib.zstdDecompressSync)return null;
  // Fast path: pure multi-frame zstd starting at byte 0.
  try{
    const direct=zlib.zstdDecompressSync(raw,{maxOutputLength:size});
    if(direct.length===size)return direct;
  }catch{/* Fall through to interleaved frame/raw walker. */}
  const parts=[];
  let pos=0,total=0;
  while(pos<raw.length&&total<size){
    const magicAt=raw.indexOf(ZSTD_MAGIC,pos);
    if(magicAt<0){
      const span=raw.subarray(pos);
      if(total+span.length>size)return null;
      parts.push(span);total+=span.length;pos=raw.length;
      break;
    }
    if(magicAt>pos){
      const span=raw.subarray(pos,magicAt);
      if(total+span.length>size)return null;
      parts.push(span);total+=span.length;pos=magicAt;
    }
    // Find the end of this zstd frame by scanning ahead to the next magic or end of buffer.
    let decoded=null,nextPos=raw.length;
    let search=pos+4;
    while(true){
      const candidate=raw.indexOf(ZSTD_MAGIC,search);
      const end=candidate<0?raw.length:candidate;
      try{
        const out=zlib.zstdDecompressSync(raw.subarray(pos,end),{maxOutputLength:size-total});
        decoded=out;nextPos=end;break;
      }catch{
        if(candidate<0)break;
        search=candidate+4;
      }
    }
    if(!decoded)return null;
    parts.push(decoded);total+=decoded.length;pos=nextPos;
  }
  return total===size?Buffer.concat(parts,total):null;
}

function unpack(raw,{kind,size}){
  if(size>MAX_BIN)return null;
  if(kind===0)return raw.length===size?raw:null;
  if(kind===1){
    const out=zlib.gunzipSync(raw,{maxOutputLength:size});
    return out.length===size?out:null;
  }
  if(kind===3&&zlib.zstdDecompressSync){
    const out=zlib.zstdDecompressSync(raw,{maxOutputLength:size});
    return out.length===size?out:null;
  }
  if(kind===4)return decompressChunked(raw,size);
  return null;
}
function wadTable(wad){
  if(wad.length<WAD_HEADER||wad.toString('latin1',0,2)!=='RW'||wad[2]!==3)return null;
  const end=WAD_HEADER+wad.readUInt32LE(268)*WAD_ENTRY;
  return end<=wad.length?wad.subarray(WAD_HEADER,end):null;
}
/** One file of a WAD held in memory. */
export function readWadFile(wad,file){
  const table=wadTable(wad),entry=table&&findEntry(table,wadHash(file));
  return entry?unpack(wad.subarray(entry.offset,entry.offset+entry.compressed),entry):null;
}
/** One file of a WAD on disk, without reading the rest of it. */
export async function readWadFileOnDisk(wadPath,file){
  return (await readWadFilesOnDisk(wadPath,[file])).get(file)??null;
}
/** Several files of a WAD on disk, reading its table once. */
export async function readWadFilesOnDisk(wadPath,files){
  const out=new Map();
  const handle=await open(wadPath);
  try{
    const header=Buffer.alloc(WAD_HEADER);
    const head=await handle.read(header,0,WAD_HEADER,0);
    if(head.bytesRead!==WAD_HEADER||header.toString('latin1',0,2)!=='RW'||header[2]!==3)return out;
    const table=Buffer.alloc(header.readUInt32LE(268)*WAD_ENTRY);
    const read=await handle.read(table,0,table.length,WAD_HEADER);
    if(read.bytesRead!==table.length)return out;
    for(const file of files){
      const entry=findEntry(table,wadHash(file));
      if(!entry||entry.compressed>MAX_BIN){out.set(file,null);continue;}
      const raw=Buffer.alloc(entry.compressed);
      await handle.read(raw,0,raw.length,entry.offset);
      out.set(file,unpack(raw,entry));
    }
  }finally{await handle.close();}
  return out;
}
/**
 * Members of a WAD on disk by hash, reading its table once. The map holds only the hashes the
 * WAD has, each unpacked, or null when too large or unreadable. Null when the WAD cannot be read.
 */
export async function readWadHashesOnDisk(wadPath,hashes){
  const handle=await open(wadPath).catch(()=>null);
  if(!handle)return null;
  try{
    const header=Buffer.alloc(WAD_HEADER);
    const head=await handle.read(header,0,WAD_HEADER,0);
    if(head.bytesRead!==WAD_HEADER||header.toString('latin1',0,2)!=='RW'||header[2]!==3)return null;
    const table=Buffer.alloc(header.readUInt32LE(268)*WAD_ENTRY);
    const read=await handle.read(table,0,table.length,WAD_HEADER);
    if(read.bytesRead!==table.length)return null;
    const out=new Map();
    for(const hash of hashes){
      const entry=findEntry(table,hash);
      if(!entry)continue;
      if(entry.compressed>MAX_BIN){out.set(hash,null);continue;}
      const raw=Buffer.alloc(entry.compressed);
      await handle.read(raw,0,raw.length,entry.offset);
      try{out.set(hash,unpack(raw,entry));}catch{out.set(hash,null);}
    }
    return out;
  }finally{await handle.close();}
}
/** A WAD of plain, uncompressed files, sorted as League and LTK Manager look them up. */
export function writeWad(files){
  const rows=files.map(({file,bytes})=>({hash:wadHash(file),bytes})).sort((a,b)=>a.hash<b.hash?-1:a.hash>b.hash?1:0);
  const header=Buffer.alloc(WAD_HEADER);
  header.write('RW','latin1');header[2]=3;header[3]=4;
  header.writeUInt32LE(rows.length,268);
  const table=Buffer.alloc(rows.length*WAD_ENTRY);
  let offset=WAD_HEADER+table.length;
  rows.forEach(({hash,bytes},index)=>{
    const at=index*WAD_ENTRY;
    table.writeBigUInt64LE(hash,at);
    table.writeUInt32LE(offset,at+8);table.writeUInt32LE(bytes.length,at+12);table.writeUInt32LE(bytes.length,at+16);
    offset+=bytes.length;
  });
  return Buffer.concat([header,table,...rows.map(row=>row.bytes)]);
}
/**
 * The WAD with extra uncompressed members added. Existing members keep their exact
 * compressed bytes and flags, so a package that ships handcrafted files beside the
 * skin (Revenant Reign Viego's sword data) is not rewritten by a model copy.
 */
export function addWadFiles(wad,files){
  const rows=wadRows(wad);
  const present=new Set(rows.map(row=>row.hash.toString()));
  for(const {file,bytes} of files){
    const hash=wadHash(file);
    if(present.has(hash.toString()))continue;
    rows.push(plainRow(hash,bytes));
    present.add(hash.toString());
  }
  return writeWadRows(wad,rows);
}
/** Every member of a WAD as it is stored: hash, compressed bytes, sizes and flags. */
export function wadRows(wad){
  if(wad.length<WAD_HEADER||wad.toString('latin1',0,2)!=='RW'||wad[2]!==3)throw new Error('Unsupported WAD archive.');
  const count=wad.readUInt32LE(268),end=WAD_HEADER+count*WAD_ENTRY;
  if(end>wad.length)throw new Error('Incomplete WAD table.');
  const rows=[];
  for(let at=WAD_HEADER;at<end;at+=WAD_ENTRY){
    const offset=wad.readUInt32LE(at+8),compressed=wad.readUInt32LE(at+12);
    if(offset<end||offset+compressed>wad.length)throw new Error('Incomplete WAD member.');
    rows.push({
      hash:wad.readBigUInt64LE(at),raw:wad.subarray(offset,offset+compressed),
      compressed,size:wad.readUInt32LE(at+16),flags:Buffer.from(wad.subarray(at+20,at+WAD_ENTRY)),
    });
  }
  return rows;
}
/** An uncompressed member. */
export const plainRow=(hash,bytes)=>({hash,raw:bytes,compressed:bytes.length,size:bytes.length,flags:Buffer.alloc(12)});
/** A row's file, unpacked, or null when it cannot be read. */
export const unpackRow=row=>unpack(row.raw,{kind:row.flags[0]&15,size:row.size});
/** These rows as a WAD, with `wad`'s first four header bytes. */
export function writeWadRows(wad,rows){
  const header=Buffer.alloc(WAD_HEADER);wad.copy(header,0,0,4);header.writeUInt32LE(rows.length,268);
  const table=Buffer.alloc(rows.length*WAD_ENTRY),parts=[];
  let offset=WAD_HEADER+table.length;
  rows.forEach((row,index)=>{
    const at=index*WAD_ENTRY;
    table.writeBigUInt64LE(row.hash,at);table.writeUInt32LE(offset,at+8);
    table.writeUInt32LE(row.compressed,at+12);table.writeUInt32LE(row.size,at+16);
    row.flags.copy(table,at+20,0,12);
    offset+=row.raw.length;parts.push(row.raw);
  });
  return Buffer.concat([header,table,...parts]);
}
/** A ZIP of stored files: all a Fantome package needs. */
export function writeZip(files){
  const locals=[],central=[];let offset=0;
  for(const {name,bytes} of files){
    const title=Buffer.from(name,'utf8'),crc=zlib.crc32(bytes);
    const local=Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50,0);local.writeUInt16LE(20,4);local.writeUInt16LE(0x0800,6);
    local.writeUInt32LE(crc,14);local.writeUInt32LE(bytes.length,18);local.writeUInt32LE(bytes.length,22);local.writeUInt16LE(title.length,26);
    const record=Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50,0);record.writeUInt16LE(20,4);record.writeUInt16LE(20,6);record.writeUInt16LE(0x0800,8);
    record.writeUInt32LE(crc,16);record.writeUInt32LE(bytes.length,20);record.writeUInt32LE(bytes.length,24);record.writeUInt16LE(title.length,28);
    record.writeUInt32LE(offset,42);
    locals.push(local,title,bytes);central.push(record,title);
    offset+=local.length+title.length+bytes.length;
  }
  const directory=Buffer.concat(central),end=Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50,0);end.writeUInt16LE(files.length,8);end.writeUInt16LE(files.length,10);
  end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);
  return Buffer.concat([...locals,directory,end]);
}
/**
 * The champion's WAD inside a package, by the archive's own name. Some packages hold it as a
 * folder of loose files instead, so those wanted are read as they are.
 */
async function readChampionWad(file,champion,wanted){
  const zip=await yauzl.openPromise(file,{autoClose:false,validateEntrySizes:true});
  const bytesOf=entry=>readEntry(zip,entry);
  try{
    let name=null,wad=null;
    const loose=new Map();
    const byHash=new Map(wanted.map(target=>[wadHash(target).toString(16).padStart(16,'0'),target]));
    for await(const entry of zip.eachEntry()){
      const parts=entry.fileName.replaceAll(BACKSLASH,'/').split('/');
      if(parts.length<2||parts[0].toUpperCase()!=='WAD'||parts[1].toLowerCase()!==`${champion}.wad.client`)continue;
      name=parts[1];
      if(parts.length===2){
        if(entry.uncompressedSize>MAX_ARCHIVE_WAD)throw new Error('The champion archive is too large to read.');
        wad=await bytesOf(entry);
      }else{
        const inside=parts.slice(2).join('/').toLowerCase();
        const hashed=!inside.includes('/')?byHash.get(/^([0-9a-f]{16})(?:\.[^./]+)?$/.exec(inside)?.[1]||''):null;
        const matched=wanted.includes(inside)?inside:hashed;
        if(!matched)continue;
        if(entry.uncompressedSize>MAX_BIN)throw new Error('The champion skin file is too large to read.');
        loose.set(matched,await bytesOf(entry));
      }
    }
    const table=wad&&wadTable(wad);
    if(wad&&!table)throw new Error('The champion archive could not be read.');
    return name&&{name,read:target=>{
      const entry=table&&findEntry(table,wadHash(target));
      if(!entry)return loose.get(target)||null;
      const bytes=unpack(wad.subarray(entry.offset,entry.offset+entry.compressed),entry);
      if(!bytes||bytes.length!==entry.size)throw new Error('The champion skin file could not be read.');
      return bytes;
    }};
  }finally{zip.close();}
}
const gameBin=async(wadName,file,league=leagueFolder)=>
  readWadFileOnDisk(path.join(await league(),'Game','DATA','FINAL','Champions',wadName),file);
/** The champion's WAD as League spells it (`MasterYi.wad.client`), or the lower-case name. */
async function leagueWadName(alias,league=leagueFolder){
  const wanted=`${alias}.wad.client`;
  try{return (await readdir(path.join(await league(),'Game','DATA','FINAL','Champions'))).find(name=>name.toLowerCase()===wanted)||wanted;}
  catch{return wanted;}
}

/**
 * Builds the small mod that puts this skin at `slot`, and returns its path. Null only when the
 * package's own skin data cannot be moved. Never a reason to change what the player selected
 * in League's client.
 *
 * Many custom skins carry no `skin0.bin` at all: they only replace the base skin's model,
 * textures or voice (Big Smoke Nasus, Rick Sanchez Viktor's voice WAD). They show only when
 * League loads the base skin's data, so the copy at `slot` is League's own `skin0.bin`,
 * re-keyed: the selected skin then draws the base skin's files, which the package replaces.
 * That copy is unmodified game data naming the base skin, so it hides nothing from LTK's check.
 */
export async function buildSlotMod({file,champion,slot,dir,original=gameBin,wadName=leagueWadName}){
  const alias=String(champion).toLowerCase();
  const id=createHash('sha1').update(`${await fileHash(file,'sha1')}:${alias}:${slot}:3`).digest('hex').slice(0,16);
  const out=path.join(dir,`${id}.fantome`);
  if(await stat(out).then(info=>info.isFile(),()=>false))return out;
  const names=[alias,...subcharactersOf(alias)];
  const found=await readChampionWad(file,alias,names.map(name=>skinFile(name,0)));
  const wad=found?.name||await wadName(alias);
  const files=[];
  for(const name of names){
    const own=found?.read(skinFile(name,0));
    // A package without the file draws the base skin's, as it would with the base skin selected.
    const bytes=own||await Promise.resolve().then(()=>original(wad,skinFile(name,0))).catch(()=>null);
    const moved=bytes&&await retargetBin(bytes,name,slot,wanted=>original(wad,wanted));
    if(moved)files.push({file:skinFile(name,slot),bytes:moved});
    else if(name===alias)return null;
  }
  const info={Name:`Friloverse ${alias} skin ${slot} ${id}`,Author:'Friloverse',Version:'1.0.0',Description:'Shows the chosen skin over the one selected in League. Removed after the match.'};
  const archive=writeZip([
    {name:'META/info.json',bytes:Buffer.from(JSON.stringify(info),'utf8')},
    {name:`WAD/${wad}`,bytes:writeWad(files)},
  ]);
  await mkdir(dir,{recursive:true});
  const temp=`${out}.${randomBytes(8).toString('hex')}.tmp`;
  try{await writeFile(temp,archive,{flag:'wx'});await rename(temp,out);}
  finally{await unlink(temp).catch(()=>{});}
  return out;
}
