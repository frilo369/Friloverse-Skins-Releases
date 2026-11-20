import {randomBytes,createHash} from 'node:crypto';
import {mkdir,readdir,rename,stat,unlink,writeFile} from 'node:fs/promises';
import path from 'node:path';
import yauzl from 'yauzl';
import {leagueFolder} from './league-client.mjs';
import {clientLocale} from './skin-audio.mjs';
import {readWadFileOnDisk,readWadFile,writeZip} from './skin-slots.mjs';
import {formRecordsOf} from './champion-subcharacters.mjs';
import {xxh64} from './league-icons.mjs';

// League's loading screen names the skin selected in its client. The name is a line in its text
// table, so for the match LTK writes the name of the skin picked in Friloverse into that line.
const SECRET=Buffer.from('b8fe6c3923a44bbe7c01812cf721ad1cded46de9839097db7240a4a4b7b3671fcb79e64eccc0e578825ad07dccff7221b8084674f743248ee03590e6813a264c3c2852bb91c300cb88d0658b1b532ea371644897a20df94e3819ef46a9deacd8a8fa763fe39c343ff9dcbbc7c70b4f1d8a51e04bcdb45931c89f7ec9d9787364eac5ac8334d3ebc3c581a0fffa1363eb170ddd51b7f0da49d316552629d4689e2b16be587d47a1fc8ff8b8d17ad031ce45cb3a8f95160428afd7fbcabb4b407e','hex');
const M64=(1n<<64n)-1n,PRIME=0x9E3779B185EBCA87n;
// A version 5 table keeps a key's hash in the low 38 bits of its row and the text's place above them.
const HASH_BITS=38n,HASH_MASK=(1n<<HASH_BITS)-1n;
const TABLE_START=8,ROW=8;
const RECORD_PREFIX='game_character_displayname_',OWN_PREFIX='fril_character_displayname_';
const STRINGTABLE_PATH='data/menu/en_us/lol.stringtable';
const STRINGTABLE_HASH=xxh64(STRINGTABLE_PATH);

function mix16(input,at,secretAt){
  const product=(input.readBigUInt64LE(at)^SECRET.readBigUInt64LE(secretAt))*(input.readBigUInt64LE(at+8)^SECRET.readBigUInt64LE(secretAt+8));
  return (product&M64)^(product>>64n);
}
/** XXH3 with seed 0 for 17 to 128 bytes, the only lengths these keys can have. */
export function xxh3(text){
  const input=Buffer.from(text,'utf8'),size=input.length;
  if(size<17||size>128)throw new RangeError('Only keys of 17 to 128 bytes are supported.');
  let hash=BigInt(size)*PRIME&M64;
  const rounds=size>96?4:size>64?3:size>32?2:1;
  for(let round=rounds-1;round>=0;round--){
    hash=hash+mix16(input,16*round,32*round)+mix16(input,size-16*(round+1),32*round+16)&M64;
  }
  hash^=hash>>37n;
  hash=hash*0x165667919E3779F9n&M64;
  return hash^hash>>32n;
}

/** Which line of League's text table names this skin slot. Slot 0 has only the champion's own name. */
export function nameKey(alias,slot){
  const name=String(alias).toLowerCase();
  return slot>0?`game_character_skin_displayname_${name}_${slot}`:`${RECORD_PREFIX}${name}`;
}
/** A name fit to show: not League's markup, and not the stand-in for a skin with no name yet. */
export function shownName(label){
  const name=String(label||'').replace(/[\u0000-\u001f\u007f<>]/g,' ').replace(/\s+/g,' ').trim().slice(0,80);
  return /^(riot|custom) skin$/i.test(name)?'':name;
}

/** Whether League's text table has this line, or null when it is not a table this reads. */
export function hasString(table,key){
  if(table.length<TABLE_START||table.toString('latin1',0,3)!=='RST'||table[3]!==5)return null;
  const count=table.readUInt32LE(4),data=TABLE_START+count*ROW;
  if(data>table.length)return null;
  const wanted=xxh3(key.toLowerCase())&HASH_MASK;
  for(let at=TABLE_START;at<data;at+=ROW)if((table.readBigUInt64LE(at)&HASH_MASK)===wanted)return true;
  return false;
}

/** Reads the UTF-8 string for `key` from an RST v5 table, or null if absent/unreadable. */
export function textOf(table,key){
  if(!Buffer.isBuffer(table)||table.length<TABLE_START||table.toString('latin1',0,3)!=='RST'||table[3]!==5)return null;
  const count=table.readUInt32LE(4),data=TABLE_START+count*ROW;
  if(data>table.length)return null;
  const wanted=xxh3(key.toLowerCase())&HASH_MASK;
  for(let at=TABLE_START;at<data;at+=ROW){
    const entry=table.readBigUInt64LE(at);
    if((entry&HASH_MASK)!==wanted)continue;
    const start=data+Number(entry>>HASH_BITS);
    if(start>=table.length)return null;
    const end=table.indexOf(0,start);
    return end<0?null:table.toString('utf8',start,end);
  }
  return null;
}

/**
 * Rewrites length-prefixed `game_character_displayname_<alias>` in-place to
 * `fril_character_displayname_<alias>` (identical byte length) so chat and overhead nameplates
 * keep the real champion name when slot 0 overrides the loading-screen name.
 */
export function withOwnRecordKey(record,alias){
  if(!Buffer.isBuffer(record))return null;
  const needle=Buffer.from(`${RECORD_PREFIX}${String(alias).toLowerCase()}`,'utf8');
  const lenPrefix=Buffer.alloc(2);lenPrefix.writeUInt16LE(needle.length,0);
  const replacement=Buffer.from(OWN_PREFIX,'utf8');
  let out=null,pos=0;
  while(pos+2+needle.length<=record.length){
    const found=record.indexOf(lenPrefix,pos);
    if(found<0||found+2+needle.length>record.length)break;
    const slice=record.subarray(found+2,found+2+needle.length).toString('utf8').toLowerCase();
    if(slice===needle.toString('utf8')){
      out??=Buffer.from(record);
      replacement.copy(out,found+2);
      pos=found+2+needle.length;
    }else pos=found+1;
  }
  return out;
}

/** Whether a Fantome/ZIP archive ships its own `lol.stringtable` (e.g. a font/language mod). */
export async function shipsLanguageTable(filePath){
  if(!filePath||!/\.(?:fantome|zip)$/i.test(filePath))return false;
  let zip;
  try{zip=await yauzl.openPromise(filePath,{autoClose:false});}
  catch{return false;}
  try{
    const hashHex=STRINGTABLE_HASH.toString(16).padStart(16,'0');
    for await(const entry of zip.eachEntry()){
      const name=String(entry.fileName||'').replaceAll('\\','/').toLowerCase();
      if(name.endsWith('/lol.stringtable')||name.endsWith(`/${hashHex}`)||name.includes(`/${hashHex}.`))return true;
      if(/^wad\/global\.[a-z]{2}_[a-z]{2}\.wad\.client$/i.test(name)&&entry.uncompressedSize>272&&entry.uncompressedSize<256*1024*1024){
        const chunks=[];
        for await(const chunk of await zip.openReadStreamPromise(entry))chunks.push(chunk);
        const wad=Buffer.concat(chunks);
        if(readWadFile(wad,STRINGTABLE_PATH))return true;
      }
    }
    return false;
  }catch{return false;}
  finally{zip.close();}
}

async function readRecordFiles({leagueDir,alias,read}){
  const champsDir=path.join(leagueDir,'Game','DATA','FINAL','Champions');
  const wadName=(await readdir(champsDir).catch(()=>[])).find(name=>name.toLowerCase()===`${alias}.wad.client`);
  if(!wadName)return [];
  const wadPath=path.join(champsDir,wadName);
  const characters=[alias,...formRecordsOf(alias)];
  const rawFiles=[];
  for(const character of characters){
    const inside=`data/characters/${character}/${character}.bin`;
    const record=await read(wadPath,inside).catch(()=>null);
    const patched=record&&withOwnRecordKey(record,alias);
    if(patched)rawFiles.push({name:`RAW/${inside}`,bytes:patched});
  }
  return rawFiles;
}

/**
 * An LTK mod that shows one skin's name, or null when League has no such line. LTK 1.33 rejects a
 * mod's own `lol.stringtable` and takes only its base layer's `StringOverrides` (locale, then line),
 * which it writes into League's own table as it builds the overlay. "default" covers every language.
 */
export async function buildNameMod({alias,slot,name,dir,league=leagueFolder,read=readWadFileOnDisk,keepChampionInChat=false,hasStringTableMod=false}){
  const leagueDir=await league();
  const folder=path.join(leagueDir,'Game','DATA','FINAL','Localized');
  const allWads=(await readdir(folder)).filter(file=>/^Global\.[a-z]{2}_[a-z]{2}\.wad\.client$/i.test(file)).sort();
  if(!allWads.length)return null;
  const preferred=await clientLocale(leagueDir);
  const wads=preferred
    ?[...allWads.filter(file=>file.split('.')[1]?.toLowerCase()===preferred.toLowerCase()),...allWads.filter(file=>file.split('.')[1]?.toLowerCase()!==preferred.toLowerCase())]
    :allWads;
  const lowerAlias=String(alias).toLowerCase();
  const key=nameKey(lowerAlias,slot);
  const protectChat=slot===0&&keepChampionInChat&&!hasStringTableMod;
  // 2: string overrides instead of a copied table, which LTK now rejects.
  const id=createHash('sha1').update([protectChat?'3':'2',key,name].join('\n')).digest('hex').slice(0,16);
  const out=path.join(dir,`name-${id}.fantome`);
  if(await stat(out).then(info=>info.isFile(),()=>false))return out;
  let foundTable=null;
  for(const wad of wads){
    const wadPath=path.join(folder,wad),locale=wad.split('.')[1].toLowerCase();
    // League stores lol.stringtable at data/menu/en_us/lol.stringtable inside EVERY locale WAD.
    let table=await read(wadPath,STRINGTABLE_PATH).catch(()=>null);
    if((!table||!hasString(table,key))&&locale!=='en_us'){
      table=await read(wadPath,`data/menu/${locale}/lol.stringtable`).catch(()=>null);
    }
    if(table&&hasString(table,key)){foundTable=table;break;}
  }
  if(!foundTable)return null;
  const overrides={[key]:name};
  const extraFiles=[];
  if(protectChat){
    const championName=textOf(foundTable,`${RECORD_PREFIX}${lowerAlias}`);
    if(championName){
      const records=await readRecordFiles({leagueDir,alias:lowerAlias,read});
      if(records.length){
        overrides[`${OWN_PREFIX}${lowerAlias}`]=championName;
        extraFiles.push(...records);
      }
    }
  }
  const info={Name:`Friloverse skin name ${id}`,Author:'Friloverse',Version:'1.0.0',Description:"Shows the chosen skin's name on the loading screen. Removed after the match.",
    Layers:{base:{Name:'base',Priority:0,StringOverrides:{default:overrides}}}};
  const archive=writeZip([
    {name:'META/info.json',bytes:Buffer.from(JSON.stringify(info),'utf8')},
    ...extraFiles,
  ]);
  await mkdir(dir,{recursive:true});
  const temp=`${out}.${randomBytes(8).toString('hex')}.tmp`;
  try{await writeFile(temp,archive,{flag:'wx'});await rename(temp,out);}
  finally{await unlink(temp).catch(()=>{});}
  return out;
}
