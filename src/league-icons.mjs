// Read summoner artwork straight from the installed League client's archives, the
// way FrYiLoCo does. Read-only, and no file stays open: League must be able to patch.
import {leagueFolder} from './league-client.mjs';
import {open,stat} from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';

const ARCHIVES=['default-assets.wad','default-assets2.wad'];
const GAME_DATA='plugins/rcp-be-lol-game-data/global/default/',ASSETS=`${GAME_DATA}v1`;
const MAX_ICON=2*1024*1024,MAX_CATALOGUE=8*1024*1024;
// What the Mayhem guide may ask for: a picture or a JSON list under League's game data, named the way
// CommunityDragon names it (lowercase, below .../global/default/). Never a path out of that folder.
const GAME_FILE=/^(?:assets|v1)\/[a-z0-9_.\/-]+\.(?:png|jpg|json)$/;
const HEADER_V3=272,ENTRY=32;
// League's default-assets archives hold tens of thousands of files; a count far past that is a
// damaged or half-patched header, and must never size a buffer.
const MAX_ENTRIES=500000;
const RETRY_ROOT=30000;

const MASK=(1n<<64n)-1n,P1=11400714785074694791n,P2=14029467366897019727n,P3=1609587929392839161n,P4=9650029242287828579n,P5=2870177450012600261n;
const rotate=(value,bits)=>((value<<bits)|(value>>(64n-bits)))&MASK;
const round=(acc,input)=>(rotate((acc+input*P2)&MASK,31n)*P1)&MASK;
const merge=(acc,value)=>(((acc^round(0n,value))*P1)+P4)&MASK;

/** XXH64 with seed 0, which WAD archives use to name their files. */
export function xxh64(text){
  const data=Buffer.from(text,'utf8');
  let offset=0,hash;
  if(data.length>=32){
    let v1=(P1+P2)&MASK,v2=P2,v3=0n,v4=(0n-P1)&MASK;
    for(;offset+32<=data.length;offset+=32){
      v1=round(v1,data.readBigUInt64LE(offset));v2=round(v2,data.readBigUInt64LE(offset+8));
      v3=round(v3,data.readBigUInt64LE(offset+16));v4=round(v4,data.readBigUInt64LE(offset+24));
    }
    hash=(rotate(v1,1n)+rotate(v2,7n)+rotate(v3,12n)+rotate(v4,18n))&MASK;
    for(const value of [v1,v2,v3,v4])hash=merge(hash,value);
  }else hash=P5;
  hash=(hash+BigInt(data.length))&MASK;
  for(;offset+8<=data.length;offset+=8)hash=((rotate(hash^round(0n,data.readBigUInt64LE(offset)),27n)*P1)+P4)&MASK;
  if(offset+4<=data.length){hash=((rotate(hash^((BigInt(data.readUInt32LE(offset))*P1)&MASK),23n)*P2)+P3)&MASK;offset+=4;}
  for(;offset<data.length;offset++)hash=(rotate(hash^((BigInt(data[offset])*P5)&MASK),11n)*P1)&MASK;
  hash^=hash>>33n;hash=(hash*P2)&MASK;hash^=hash>>29n;hash=(hash*P3)&MASK;hash^=hash>>32n;
  return hash;
}

function imageType(bytes){
  if(bytes.length>3&&bytes[0]===0xff&&bytes[1]===0xd8&&bytes[2]===0xff)return 'image/jpeg';
  if(bytes.subarray(0,8).toString('hex')==='89504e470d0a1a0a')return 'image/png';
  return null;
}

/** Only numeric IDs reach this: a caller cannot name an archive or a file. */
export function iconId(value){
  return /^\d{1,10}$/.test(String(value))&&Number(value)<=0xffffffff?Number(value):null;
}

export class LeagueIcons{
  constructor({leaguePath=leagueFolder,now=Date.now,decompress=decompressChunk,readArchiveTable=readTable}={}){
    this.leaguePath=leaguePath;this.now=now;this.decompress=decompress;this.readArchiveTable=readArchiveTable;
    this.root=null;this.rootChecked=0;this.tables=new Map();this.pending=new Map();
  }
  async read(id){
    const number=iconId(id);
    if(number===null)return null;
    const bytes=await this.asset([`${ASSETS}/profile-icons/${number}.jpg`,`${ASSETS}/profile-icons/${number}.png`],MAX_ICON,value=>Boolean(imageType(value)));
    return bytes?{bytes,type:imageType(bytes)}:null;
  }
  /** A chroma's swatch picture, the one League's own skin picker shows. */
  async chroma(champion,id){
    const key=iconId(champion),number=iconId(id);
    if(key===null||number===null)return null;
    // 12.0: League moved most swatches to ASSETS/Characters/<Champion>/Skins/SkinNN/ChromaPreview.*.png,
    // and only its skins.json says where; the old champion-chroma-images path stays the second choice.
    const moved=(await this.chromaPaths().catch(()=>null))?.get(number);
    const bytes=await this.asset([...(moved?[`${GAME_DATA}${moved}`]:[]),`${ASSETS}/champion-chroma-images/${key}/${number}.png`],MAX_ICON,value=>Boolean(imageType(value)));
    return bytes?{bytes,type:imageType(bytes)}:null;
  }
  /** Chroma number -> its swatch's path below .../global/default/, out of League's skins.json; reread when League patches. */
  async chromaPaths(){
    const root=await this.findRoot();
    const stamp=(await Promise.all(ARCHIVES.map(name=>stat(path.join(root,'Plugins','rcp-be-lol-game-data',name))
      .then(info=>`${info.size}:${info.mtimeMs}`,()=>'')))).join('|');
    if(this.chromaList?.stamp!==stamp){
      const reading=this.gameFile('v1/skins.json').then(file=>{
        const paths=new Map();
        if(!file)return paths;
        const add=chroma=>{
          const relative=/^\/lol-game-data\/assets\/(.+)$/i.exec(String(chroma?.chromaPath??''))?.[1]?.toLowerCase();
          if(iconId(chroma?.id)!==null&&relative&&GAME_FILE.test(relative)&&!relative.split('/').some(part=>!part||part==='.'||part==='..'))paths.set(Number(chroma.id),relative);
        };
        for(const skin of Object.values(JSON.parse(file.bytes.toString('utf8'))??{}))for(const chroma of Array.isArray(skin?.chromas)?skin.chromas:[])add(chroma);
        return paths;
      });
      this.chromaList={stamp,reading};
      // A read that failed or found nothing is tried again on the next picture.
      reading.then(paths=>{if(!paths.size&&this.chromaList?.reading===reading)this.chromaList=null;},()=>{if(this.chromaList?.reading===reading)this.chromaList=null;});
    }
    return this.chromaList.reading;
  }
  /** One picture or JSON list of League's game data, by its path below .../global/default/. */
  async gameFile(relative){
    const name=String(relative??'').toLowerCase();
    if(!GAME_FILE.test(name)||name.split('/').some(part=>!part||part==='.'||part==='..'))return null;
    if(name.endsWith('.json')){
      const bytes=await this.asset([`${GAME_DATA}${name}`],MAX_CATALOGUE,value=>{try{JSON.parse(value.toString('utf8'));return true;}catch{return false;}});
      return bytes?{bytes,type:'application/json; charset=utf-8'}:null;
    }
    const bytes=await this.asset([`${GAME_DATA}${name}`],MAX_ICON,value=>Boolean(imageType(value)));
    return bytes?{bytes,type:imageType(bytes)}:null;
  }
  /** League's own list, so icons from a newer patch appear without an app update. */
  async catalogue(){
    const bytes=await this.asset([`${ASSETS}/summoner-icons.json`],MAX_CATALOGUE,value=>{
      try{return Array.isArray(JSON.parse(value.toString('utf8')));}catch{return false;}
    });
    return bytes?JSON.parse(bytes.toString('utf8')):null;
  }
  async asset(paths,maximum,valid){
    const root=await this.findRoot();
    for(const name of ARCHIVES){
      const file=path.join(root,'Plugins','rcp-be-lol-game-data',name);
      const table=await this.table(file);
      if(!table)continue;
      for(const asset of paths){
        const entry=findEntry(table,xxh64(asset));
        if(!entry||entry.compressed>maximum||entry.size>maximum)continue;
        const bytes=await this.chunk(file,entry).catch(()=>null);
        if(bytes&&valid(bytes))return bytes;
      }
    }
    return null;
  }
  async findRoot(){
    if(!this.root||this.now()-this.rootChecked>RETRY_ROOT){
      this.root=await this.leaguePath();this.rootChecked=this.now();
    }
    return this.root;
  }
  /**
   * One table per archive, reread when Riot patches the file. A table that is not a WAD is kept
   * as missing for that version of the file; a read that fails (Riot or an antivirus holding
   * the file) is tried again on the next request. Pictures asked for together share one read.
   */
  async table(file){
    let info;
    try{info=await stat(file);}catch{this.tables.delete(file);return null;}
    const known=this.tables.get(file),stamp=`${info.size}:${info.mtimeMs}`;
    if(known?.stamp===stamp)return known.table;
    const key=`${file}|${stamp}`;
    let reading=this.pending.get(key);
    if(!reading){
      reading=this.readArchiveTable(file).then(table=>{this.tables.set(file,{stamp,table});return table;},()=>null)
        .finally(()=>this.pending.delete(key));
      this.pending.set(key,reading);
    }
    return reading;
  }
  async chunk(file,entry){
    const handle=await open(file,'r');
    try{
      const raw=Buffer.alloc(entry.compressed);
      const {bytesRead}=await handle.read(raw,0,entry.compressed,entry.offset);
      if(bytesRead!==entry.compressed)return null;
      return await this.decompress(raw,entry);
    }finally{await handle.close();}
  }
}

/** The archive's sorted file table, or null when the file is not a whole version 3 WAD. */
export async function readTable(file){
  const handle=await open(file,'r');
  try{
    const head=Buffer.alloc(HEADER_V3);
    if(await readFully(handle,head,0)!==HEADER_V3||head.toString('latin1',0,2)!=='RW'||head[2]!==3)return null;
    const count=head.readUInt32LE(HEADER_V3-4),{size}=await handle.stat();
    if(count<1||count>MAX_ENTRIES||HEADER_V3+count*ENTRY>size)return null;
    const table=Buffer.alloc(count*ENTRY);
    return await readFully(handle,table,HEADER_V3)===table.length?table:null;
  }finally{await handle.close();}
}

/** Reads until the buffer is full or the file ends; one read may return less than asked. */
async function readFully(handle,buffer,position){
  let filled=0;
  while(filled<buffer.length){
    const {bytesRead}=await handle.read(buffer,filled,buffer.length-filled,position+filled);
    if(!bytesRead)break;
    filled+=bytesRead;
  }
  return filled;
}

// Riot sorts the table by hash, so a search touches only a few entries.
function findEntry(table,hash){
  let low=0,high=table.length/ENTRY-1;
  while(low<=high){
    const middle=(low+high)>>>1,at=middle*ENTRY,value=table.readBigUInt64LE(at);
    if(value===hash)return {offset:table.readUInt32LE(at+8),compressed:table.readUInt32LE(at+12),size:table.readUInt32LE(at+16),kind:table[at+20]&0x0f};
    if(value<hash)low=middle+1;else high=middle-1;
  }
  return null;
}

function decompressChunk(raw,{kind,size}){
  if(kind===0)return raw;
  if(kind===1)return zlib.gunzipSync(raw,{maxOutputLength:size});
  if((kind===3||kind===4)&&zlib.zstdDecompressSync)return zlib.zstdDecompressSync(raw,{maxOutputLength:size});
  return null;
}
