import {binHash,parseBin,writeBin,wadRows,unpackRow,plainRow,writeWadRows} from './skin-slots.mjs';

// Some properties League now reads in another type. LTK's Repair converts most of them, but not
// every one, and it then calls the skin damaged, so the pick fails. The prepared copy converts
// these itself, in every BIN, named or not (2026-11-16, League 16.22 / LTK 1.33.0):
// - StaticMaterialDef `type` is a u8. LTK narrows a u32 only in a BIN whose path it knows, and
//   skins saved under hashes keep it (Travis Scott Ekko and Kayn, Homelander Camille, Zidane
//   Kog'Maw, Iron Golem Mordekaiser, Death Phantom Pyke, Flins Zaahen, Minato Zed).
// - SkinCharacterDataProperties `OverrideOnScreenName` is text. Radahn Pantheon saved it as the
//   hash of "Radahn", which LTK cannot turn back. The text comes back when a word of the skin's
//   own name has that hash; otherwise the property goes, as League drops its value anyway.
const U8=3,U32=7,STRING=16,HASH=17;
const STATIC_MATERIAL_DEF=binHash('StaticMaterialDef'),STATIC_MATERIAL_DEF_NAME=binHash('name');
const rules=new Map([
  [`${STATIC_MATERIAL_DEF}:${binHash('type')}`,{from:U32,to:U8}],
  [`${binHash('SkinCharacterDataProperties')}:${binHash('OverrideOnScreenName')}`,{from:HASH,to:STRING}],
]);
const WIDTHS={0:0,1:1,2:1,3:1,4:2,5:2,6:4,7:4,8:8,9:8,10:4,11:8,12:12,13:16,14:64,15:4,17:4,18:8,132:4,135:1};
const u16=value=>{const out=Buffer.alloc(2);out.writeUInt16LE(value);return out;};
const u32=value=>{const out=Buffer.alloc(4);out.writeUInt32LE(value>>>0);return out;};

class Unreadable extends Error{}
const need=(bytes,at,size)=>{if(!Number.isSafeInteger(at)||at<0||at+size>bytes.length)throw new Unreadable();};

/** The value of `type` at `at`, rebuilt: [bytes, end]. Sizes are recomputed on the way out. */
function value(bytes,at,type,state,depth){
  if(depth>128)throw new Unreadable();
  const width=WIDTHS[type];
  if(width!==undefined){need(bytes,at,width);return [bytes.subarray(at,at+width),at+width];}
  if(type===16){need(bytes,at,2);const end=at+2+bytes.readUInt16LE(at);need(bytes,at,end-at);return [bytes.subarray(at,end),end];}
  if(type===128||type===129){
    need(bytes,at,9);
    const item=bytes[at],size=bytes.readUInt32LE(at+1),start=at+5,count=bytes.readUInt32LE(start);
    need(bytes,start,size);
    if(count>0&&item===0)throw new Unreadable();
    const parts=[u32(count)];let next=start+4;
    for(let i=0;i<count;i++){const [data,end]=value(bytes,next,item,state,depth+1);parts.push(data);next=end;}
    if(next!==start+size)throw new Unreadable();
    const body=Buffer.concat(parts);
    return [Buffer.concat([Buffer.from([item]),u32(body.length),body]),next];
  }
  if(type===130||type===131){
    need(bytes,at,4);
    const cls=bytes.readUInt32LE(at);
    if(!cls)return [bytes.subarray(at,at+4),at+4];
    need(bytes,at,10);
    const size=bytes.readUInt32LE(at+4),start=at+8;
    need(bytes,start,size);
    const [body,end]=fields(bytes,start,cls,state,depth+1);
    if(end!==start+size)throw new Unreadable();
    return [Buffer.concat([u32(cls),u32(body.length),body]),end];
  }
  if(type===133){
    need(bytes,at,2);
    const item=bytes[at],present=bytes[at+1];
    if(present>1)throw new Unreadable();
    if(!present)return [bytes.subarray(at,at+2),at+2];
    const [inner,end]=value(bytes,at+2,item,state,depth+1);
    return [Buffer.concat([bytes.subarray(at,at+2),inner]),end];
  }
  if(type===134){
    need(bytes,at,10);
    const key=bytes[at],item=bytes[at+1],size=bytes.readUInt32LE(at+2),start=at+6,count=bytes.readUInt32LE(start);
    need(bytes,start,size);
    if(count>0&&key===0&&item===0)throw new Unreadable();
    const parts=[u32(count)];let next=start+4;
    for(let i=0;i<count;i++){
      const [k,afterKey]=value(bytes,next,key,state,depth+1),[v,end]=value(bytes,afterKey,item,state,depth+1);
      parts.push(k,v);next=end;
    }
    if(next!==start+size)throw new Unreadable();
    const body=Buffer.concat(parts);
    return [Buffer.concat([Buffer.from([key,item]),u32(body.length),body]),next];
  }
  throw new Unreadable();
}

/** One property in League's current type: its bytes, or null to leave it out. */
function convert(name,type,data,state,rule){
  if(rule.from===U32&&rule.to===U8){
    const number=data.readUInt32LE(0);
    if(number>0xff)return undefined;
    return Buffer.concat([u32(name),Buffer.from([U8,number])]);
  }
  if(rule.from===HASH&&rule.to===STRING){
    const text=state.names.get(data.readUInt32LE(0));
    if(text===undefined)return null;
    const bytes=Buffer.from(text,'utf8');
    return Buffer.concat([u32(name),Buffer.from([STRING]),u16(bytes.length),bytes]);
  }
  return undefined;
}

/** A field count and its fields, from `at`: [bytes, end]. */
function fields(bytes,at,cls,state,depth){
  need(bytes,at,2);
  const count=bytes.readUInt16LE(at),parts=[];
  let next=at+2,kept=0;
  for(let i=0;i<count;i++){
    need(bytes,next,5);
    const start=next,name=bytes.readUInt32LE(start),type=bytes[start+4];
    const wideHash=type===HASH&&cls===STATIC_MATERIAL_DEF&&name===STATIC_MATERIAL_DEF_NAME;
    const [data,end]=wideHash?(need(bytes,start+5,8),[bytes.subarray(start+5,start+13),start+13]):value(bytes,start+5,type,state,depth);
    next=end;
    const rule=rules.get(`${cls}:${name}`);
    const converted=rule?.from===type?convert(name,type,data,state,rule):undefined;
    if(converted!==undefined)state.changed++;
    if(converted===null)continue;
    parts.push(converted??Buffer.concat([bytes.subarray(start,start+5),data]));
    kept++;
  }
  return [Buffer.concat([u16(kept),...parts]),next];
}

/** FNV hashes of the skin's own name and its words, for hashed text to be written out again. */
function nameTable(names){
  const table=new Map();
  for(const name of names||[])for(const text of [name,...String(name).split(/[^\p{L}\p{N}']+/u)]){
    const trimmed=String(text).trim();
    if(trimmed&&trimmed.length<=200&&!table.has(binHash(trimmed)))table.set(binHash(trimmed),trimmed);
  }
  return table;
}

/**
 * This BIN with the listed properties in League's current type, and how many changed, or null
 * when nothing needed changing or it could not be read in full (it is then left as it is).
 * `names` are the skin's own names, for text saved as a hash.
 */
export function convertBinTypes(bytes,{names=[]}={}){
  if(!Buffer.isBuffer(bytes))return null;
  const bin=parseBin(bytes);
  if(!bin)return null;
  const state={changed:0,names:names instanceof Map?names:nameTable(names)};
  try{
    const objects=bin.objects.map(object=>{
      const [body,end]=fields(object.body,4,object.type,state,0);
      if(end!==object.body.length)throw new Unreadable();
      return {...object,body:Buffer.concat([object.body.subarray(0,4),body])};
    });
    return state.changed?{bytes:writeBin({...bin,objects}),changed:state.changed}:null;
  }catch(error){
    if(error instanceof Unreadable||error instanceof RangeError)return null;
    throw error;
  }
}

/** A WAD with every BIN member converted, named or not; null when none changed. */
export function convertWadTypes(wad,{names=[]}={}){
  const rows=wadRows(wad),table=nameTable(names);let changed=0;
  const next=rows.map(row=>{
    let bytes;try{bytes=unpackRow(row);}catch{return row;}
    if(!bytes||bytes.length<8||bytes.toString('latin1',0,4)!=='PROP')return row;
    const converted=convertBinTypes(bytes,{names:table});
    if(!converted)return row;
    changed+=converted.changed;
    return plainRow(row.hash,converted.bytes);
  });
  return changed?{wad:writeWadRows(wad,next),changed}:null;
}
