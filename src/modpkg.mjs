import {open,readdir} from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import {writeWadRows} from './skin-slots.mjs';
import {xxh64} from './league-icons.mjs';

// LeagueToolkit's own package (.modpkg, 10.1), as Divine Skins hands many skins out. Friloverse
// prepares and installs a Fantome, so a .modpkg is read here into the files of one: its base
// layer's WADs, each member keeping its stored (zstd) bytes, and META/info.json. The player's
// file is only ever read.
//
// Layout (version 1): `_modpkg_`, u32 version, u32 signature size, u32 chunk count, the
// signature, layers (u32 count; u32 name length, name, i32 priority), chunk paths and WAD names
// (u32 count each, then null-terminated), padding to 8 bytes, then one 61-byte record per chunk:
// u64 path hash, u64 offset, u8 compression (0 none, 1 zstd), u64 stored size, u64 full size,
// u64 stored checksum, u64 full checksum, u32 path index, u32 layer index, u32 WAD index.
// Layer and WAD index 0xFFFFFFFF are `_meta_/` files: info.msgpack and thumbnail.webp.

const MAGIC='_modpkg_',RECORD=61,NONE=0xFFFFFFFF,MAX_PACKAGE=1024*1024*1024,MSGPACK_MAX_DEPTH=32;
export const MODPKG=/\.modpkg$/i;

function damaged(){return new Error('The .modpkg file is damaged.');}

function parseHeader(b){
  if(b.length<20||b.toString('latin1',0,8)!==MAGIC)throw damaged();
  let at=8;
  const need=n=>{if(at+n>b.length)throw new RangeError('more');};
  const u32=()=>{need(4);const v=b.readUInt32LE(at);at+=4;return v;};
  const text=()=>{const end=b.indexOf(0,at);if(end<0)throw new RangeError('more');const s=b.toString('utf8',at,end);at=end+1;return s;};
  const version=u32();
  if(version!==1)throw new Error(`This .modpkg (version ${version}) is newer than Friloverse can read.`);
  const signature=u32(),count=u32();
  if(count>65535*4)throw damaged();
  need(signature);at+=signature;
  const layers=[];
  for(let n=u32();n--;){const length=u32();need(length+4);layers.push({name:b.toString('utf8',at,at+length),priority:b.readInt32LE(at+length)});at+=length+4;}
  const paths=[];for(let n=u32();n--;)paths.push(text());
  const wads=[];for(let n=u32();n--;)wads.push(text());
  at=at+7&~7;
  need(count*RECORD);
  const chunks=[];
  for(let i=0;i<count;i++,at+=RECORD){
    chunks.push({
      hash:b.readBigUInt64LE(at),offset:b.readBigUInt64LE(at+8),compression:b[at+16],
      size:b.readBigUInt64LE(at+17),full:b.readBigUInt64LE(at+25),
      storedChecksum:b.readBigUInt64LE(at+33),fullChecksum:b.readBigUInt64LE(at+41),
      path:b.readUInt32LE(at+49),layer:b.readUInt32LE(at+53),wad:b.readUInt32LE(at+57),
    });
  }
  return {layers,paths,wads,chunks,end:at};
}

/** A .modpkg's table of contents, reading only as much of the file as it takes. */
async function readHeader(handle,fileSize){
  for(let size=256*1024;;size*=4){
    const length=Math.min(size,fileSize),buffer=Buffer.alloc(length);
    const {bytesRead}=await handle.read(buffer,0,length,0);
    try{return parseHeader(buffer.subarray(0,bytesRead));}
    catch(error){if(!(error instanceof RangeError))throw error;if(length>=fileSize||length>=64*1024*1024)throw damaged();}
  }
}

async function readChunk(handle,fileSize,chunk,limit){
  const offset=Number(chunk.offset),size=Number(chunk.size),full=Number(chunk.full);
  if(chunk.compression>1||offset+size>fileSize||size>limit||full>limit)throw damaged();
  const raw=Buffer.alloc(size);
  const {bytesRead}=await handle.read(raw,0,size,offset);
  if(bytesRead!==size)throw damaged();
  return raw;
}
const unpack=(raw,chunk)=>{
  const out=chunk.compression?zlib.zstdDecompressSync(raw,{maxOutputLength:Number(chunk.full)}):raw;
  if(out.length!==Number(chunk.full))throw damaged();
  return out;
};

/** MessagePack, bounded in depth and allocation size: no extension types. */
export function decodeMsgpack(b){
  let at=0;
  const need=n=>{if(n<0||at+n>b.length)throw damaged();};
  const str=n=>{need(n);const s=b.toString('utf8',at,at+n);at+=n;return s;};
  const bin=n=>{need(n);const s=b.subarray(at,at+n);at+=n;return s;};
  const read=(n,f)=>{need(n);const v=f(at);at+=n;return v;};
  const many=(n,pair,depth)=>{
    // Every item or key+value pair needs at least 1 or 2 bytes in the input.
    if(n>(b.length-at)/(pair?2:1))throw damaged();
    if(pair){const out={};for(let i=0;i<n;i++){const key=value(depth+1);out[String(key)]=value(depth+1);}return out;}
    const out=[];for(let i=0;i<n;i++)out.push(value(depth+1));return out;
  };
  function value(depth){
    if(depth>MSGPACK_MAX_DEPTH)throw damaged();
    need(1);const t=b[at++];
    if(t<=0x7f)return t;
    if(t>=0xe0)return t-256;
    if((t&0xf0)===0x80)return many(t&15,true,depth);
    if((t&0xf0)===0x90)return many(t&15,false,depth);
    if((t&0xe0)===0xa0)return str(t&31);
    switch(t){
      case 0xc0:return null;case 0xc2:return false;case 0xc3:return true;
      case 0xc4:return bin(read(1,a=>b[a]));case 0xc5:return bin(read(2,a=>b.readUInt16BE(a)));case 0xc6:return bin(read(4,a=>b.readUInt32BE(a)));
      case 0xca:return read(4,a=>b.readFloatBE(a));case 0xcb:return read(8,a=>b.readDoubleBE(a));
      case 0xcc:return read(1,a=>b[a]);case 0xcd:return read(2,a=>b.readUInt16BE(a));case 0xce:return read(4,a=>b.readUInt32BE(a));case 0xcf:return Number(read(8,a=>b.readBigUInt64BE(a)));
      case 0xd0:return read(1,a=>b.readInt8(a));case 0xd1:return read(2,a=>b.readInt16BE(a));case 0xd2:return read(4,a=>b.readInt32BE(a));case 0xd3:return Number(read(8,a=>b.readBigInt64BE(a)));
      case 0xd9:return str(read(1,a=>b[a]));case 0xda:return str(read(2,a=>b.readUInt16BE(a)));case 0xdb:return str(read(4,a=>b.readUInt32BE(a)));
      case 0xdc:return many(read(2,a=>b.readUInt16BE(a)),false,depth);case 0xdd:return many(read(4,a=>b.readUInt32BE(a)),false,depth);
      case 0xde:return many(read(2,a=>b.readUInt16BE(a)),true,depth);case 0xdf:return many(read(4,a=>b.readUInt32BE(a)),true,depth);
      default:throw damaged();
    }
  }
  return value(0);
}

/** Name, author, version and description, as a Fantome's META/info.json has them. */
function fantomeInfo(info){
  const text=value=>typeof value==='string'?value.trim():'';
  const authors=Array.isArray(info?.authors)?info.authors.map(row=>text(typeof row==='string'?row:row?.name)).filter(Boolean):[];
  return {Name:text(info?.display_name)||text(info?.name),Author:authors.join(', '),Version:text(info?.version),Description:text(info?.description)};
}

const metaChunk=(header,...names)=>{
  const wanted=new Set(names.map(name=>name.toLowerCase()));
  return header.chunks.find(chunk=>chunk.wad===NONE&&wanted.has(header.paths[chunk.path]?.toLowerCase()||''));
};

/** Legacy league-mod <= 0.2.0 .modpkg stored WAD folder in path with wad_index == 0xFFFFFFFF. */
function legacyWadChunk(header,chunk){
  if(chunk.wad!==NONE||chunk.path>=header.paths.length)return null;
  const normalized=header.paths[chunk.path].replaceAll('\\','/').replace(/^\/+/,'');
  const slash=normalized.indexOf('/');
  if(slash<1)return null;
  const wadName=normalized.slice(0,slash),inner=normalized.slice(slash+1);
  if(!/^[^/]+\.wad(?:\.client)?$/i.test(wadName)||!inner)return null;
  const hex=!inner.includes('/')?/^([0-9a-f]{16})(?:\.[^./]+)?$/i.exec(inner)?.[1]:null;
  const hash=hex?BigInt(`0x${hex}`):xxh64(inner.toLowerCase());
  return {wadName,hash};
}

/** What a skin card shows: name, author, version and picture. Reads only those. */
export async function readModpkgCard(file,{imageLimit=3*1024*1024}={}){
  const handle=await open(file,'r');
  try{
    const {size}=await handle.stat(),header=await readHeader(handle,size),result={};
    const info=metaChunk(header,'_meta_/info.msgpack','_meta_/metadata.msgpack');
    if(info){
      const meta=fantomeInfo(decodeMsgpack(unpack(await readChunk(handle,size,info,256*1024),info)));
      result.name=meta.Name.slice(0,140);result.author=meta.Author.slice(0,100);result.version=meta.Version.slice(0,60);
    }
    const thumbnail=metaChunk(header,'_meta_/thumbnail.webp');
    if(thumbnail&&Number(thumbnail.full)<=imageLimit)result.image={type:'image/webp',bytes:unpack(await readChunk(handle,size,thumbnail,imageLimit),thumbnail)};
    return result;
  }finally{await handle.close();}
}

/** The names of the WADs a .modpkg ships. */
export async function modpkgWadNames(file,{checkContents=false}={}){
  const handle=await open(file,'r');
  try{
    const {size}=await handle.stat(),header=await readHeader(handle,size);
    if(!checkContents)return header.wads;
    const base=Math.max(0,header.layers.findIndex(layer=>layer.name.toLowerCase()==='base'));
    const wads=new Set();
    const seenKeys=new Map();
    for(const chunk of header.chunks){
      if(chunk.offset<BigInt(header.end)||chunk.offset+chunk.size>BigInt(size)||chunk.compression>1)throw damaged();
      if(chunk.wad===NONE){
        const legacy=legacyWadChunk(header,chunk);
        if(legacy&&(chunk.layer===NONE||chunk.layer===base))wads.add(legacy.wadName);
        continue;
      }
      if(chunk.wad>=header.wads.length||chunk.layer>=header.layers.length)throw damaged();
      const key=`${chunk.hash}:${chunk.layer}`;
      const prior=seenKeys.get(key);
      if(prior&&(prior.full!==chunk.full||prior.fullChecksum!==chunk.fullChecksum))throw damaged();
      seenKeys.set(key,{full:chunk.full,fullChecksum:chunk.fullChecksum});
      if(chunk.layer===base)wads.add(header.wads[chunk.wad]);
    }
    return [...wads];
  }
  finally{await handle.close();}
}

const leagueNames=new Map();
/** League's own WAD file names by their lower-case form, e.g. `masteryi.wad.client` -> `MasterYi.wad.client`. */
export async function leagueWadNames(league){
  const root=path.join(league,'Game','DATA','FINAL');
  if(leagueNames.has(root))return leagueNames.get(root);
  const names=new Map(),walk=async(dir,depth)=>{
    for(const item of await readdir(dir,{withFileTypes:true})){
      if(item.isDirectory()&&depth<4)await walk(path.join(dir,item.name),depth+1);
      else if(item.isFile()&&/\.wad(?:\.client)?$/i.test(item.name))names.set(item.name.toLowerCase(),item.name);
    }
  };
  try{await walk(root,0);}catch{return null;}
  if(names.size)leagueNames.set(root,names);
  return names.size?names:null;
}

/**
 * A .modpkg as the files of a Fantome: `WAD/<League's name>.wad.client` for each WAD of its base
 * layer, plus META/info.json. A WAD this League does not have (another language's) is left out,
 * as League would never read it. `names` are League's WAD names (leagueWadNames).
 */
export async function modpkgFiles(file,{names=null}={}){
  const handle=await open(file,'r');
  try{
    const {size}=await handle.stat();
    if(size>MAX_PACKAGE)throw new Error('The custom skin archive is too large.');
    const header=await readHeader(handle,size);
    const base=Math.max(0,header.layers.findIndex(layer=>layer.name.toLowerCase()==='base'));
    const files=[],byWad=new Map();
    for(const chunk of header.chunks){
      let wadKey=null,hash=chunk.hash;
      if(chunk.wad===NONE){
        const legacy=legacyWadChunk(header,chunk);
        if(!legacy||(chunk.layer!==NONE&&chunk.layer!==base))continue;
        wadKey=legacy.wadName;hash=legacy.hash;
      }else{
        if(chunk.layer!==base)continue;
        if(chunk.wad>=header.wads.length)throw damaged();
        wadKey=header.wads[chunk.wad];
      }
      if(chunk.compression>1||chunk.size>=2n**32n||chunk.full>=2n**32n)throw damaged();
      const lower=wadKey.toLowerCase().replaceAll('\\','/').split('/').pop();
      if(!/^[^/]+\.wad(?:\.client)?$/.test(lower))throw damaged();
      if(!byWad.has(lower))byWad.set(lower,new Map());
      const rows=byWad.get(lower);
      if(rows.has(hash))continue;
      const raw=await readChunk(handle,size,chunk,MAX_PACKAGE);
      const flags=Buffer.alloc(12);flags[0]=chunk.compression?3:0;
      rows.set(hash,{hash,raw,compressed:raw.length,size:Number(chunk.full),flags});
    }
    for(const [lower,rows] of byWad){
      const name=names?names.get(lower):lower;
      if(!name)continue;
      const sorted=[...rows.values()].sort((a,b)=>a.hash<b.hash?-1:a.hash>b.hash?1:0);
      files.push({name:`WAD/${name}`,bytes:writeWadRows(Buffer.from([0x52,0x57,3,4]),sorted)});
    }
    if(!files.length)throw new Error('The .modpkg has nothing for this League.');
    const info=metaChunk(header,'_meta_/info.msgpack','_meta_/metadata.msgpack');
    const meta=info?fantomeInfo(decodeMsgpack(unpack(await readChunk(handle,size,info,256*1024),info))):fantomeInfo(null);
    if(!meta.Name)meta.Name=path.basename(file).replace(MODPKG,'');
    files.push({name:'META/info.json',bytes:Buffer.from(JSON.stringify(meta),'utf8')});
    return files;
  }finally{await handle.close();}
}
