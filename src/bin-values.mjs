import {binHash} from './skin-slots.mjs';

// A reader for the current (non-legacy) property BIN value layout, deep enough to follow
// nested data such as a skin's gear upgrades. Each value keeps its byte range in the
// object's body, so a caller can replace one value and leave every other byte as it was.
// Layouts follow ltk_meta 0.9.1's Kind::unpack; anything unknown throws.
const WIDTHS=new Map([[0,0],[1,1],[2,1],[3,1],[4,2],[5,2],[6,4],[7,4],[8,8],[9,8],[10,4],[11,8],[12,12],[13,16],[14,64],[15,4],[17,4],[18,8],[132,4],[135,1]]);
const LIST=128,LIST2=129,POINTER=130,EMBED=131,LINK=132,OPTION=133,MAP=134,STRING=16,HASH=17;
const STATIC_MATERIAL_DEF=binHash('StaticMaterialDef'),STATIC_MATERIAL_DEF_NAME=binHash('name');

function need(body,at,size){
  if(!Number.isSafeInteger(at)||at<0||at+size>body.length)throw new Error('BIN value runs past its object.');
}

function fields(body,at,count,depth,owner=0){
  const out=[];
  for(let i=0;i<count;i++){
    need(body,at,5);
    const hash=body.readUInt32LE(at),kind=body[at+4];
    const wideHash=kind===HASH&&owner===STATIC_MATERIAL_DEF&&hash===STATIC_MATERIAL_DEF_NAME;
    const value=wideHash?(need(body,at+5,8),{kind,start:at+5,end:at+13,value:body.readBigUInt64LE(at+5)}):readValue(body,kind,at+5,depth+1);
    out.push({hash,...value});at=value.end;
  }
  return {fields:out,end:at};
}

/** One value of `kind` at `at`: {kind,start,end,value} (structures: {cls,fields}). */
export function readValue(body,kind,at,depth=0){
  if(depth>128)throw new Error('BIN value is nested too deeply.');
  const start=at;
  if(WIDTHS.has(kind)){
    const size=WIDTHS.get(kind);need(body,at,size);
    const value=kind===HASH||kind===LINK||kind===7?body.readUInt32LE(at):kind===1||kind===3||kind===135?body[at]:null;
    return {kind,start,end:at+size,value};
  }
  if(kind===STRING){
    need(body,at,2);const size=body.readUInt16LE(at);need(body,at+2,size);
    return {kind,start,end:at+2+size,value:body.toString('utf8',at+2,at+2+size)};
  }
  if(kind===LIST||kind===LIST2){
    need(body,at,9);
    const item=body[at],size=body.readUInt32LE(at+1),count=body.readUInt32LE(at+5),end=at+5+size;
    need(body,at+5,size);
    if(count>0&&item===0)throw new Error('BIN list cannot contain zero-width NONE items.');
    const items=[];let cursor=at+9;
    for(let i=0;i<count;i++){const value=readValue(body,item,cursor,depth+1);items.push(value);cursor=value.end;}
    if(cursor!==end)throw new Error('BIN list size does not match its items.');
    return {kind,start,end,value:items};
  }
  if(kind===POINTER||kind===EMBED){
    need(body,at,4);const cls=body.readUInt32LE(at);
    if(cls===0)return {kind,start,end:at+4,value:null};
    need(body,at+4,6);
    const size=body.readUInt32LE(at+4),end=at+8+size;need(body,at+8,size);
    const read=fields(body,at+10,body.readUInt16LE(at+8),depth,cls);
    if(read.end!==end)throw new Error('BIN structure size does not match its fields.');
    return {kind,start,end,value:{cls,fields:read.fields}};
  }
  if(kind===OPTION){
    need(body,at,2);const item=body[at];
    if(!body[at+1])return {kind,start,end:at+2,value:null};
    const value=readValue(body,item,at+2,depth+1);
    return {kind,start,end:value.end,value};
  }
  if(kind===MAP){
    need(body,at,10);
    const key=body[at],item=body[at+1],size=body.readUInt32LE(at+2),count=body.readUInt32LE(at+6),end=at+6+size;
    need(body,at+6,size);
    if(count>0&&key===0&&item===0)throw new Error('BIN map cannot contain zero-width NONE entries.');
    const entries=[];let cursor=at+10;
    for(let i=0;i<count;i++){
      const k=readValue(body,key,cursor,depth+1),v=readValue(body,item,k.end,depth+1);
      entries.push([k,v]);cursor=v.end;
    }
    if(cursor!==end)throw new Error('BIN map size does not match its entries.');
    return {kind,start,end,value:{key,item,entries}};
  }
  throw new Error(`BIN value kind ${kind} is not supported.`);
}

/** The top-level fields of one object body (its first four bytes are the object's key). */
export function objectFields(body,owner=0){
  need(body,0,6);
  const read=fields(body,6,body.readUInt16LE(4),0,owner);
  if(read.end!==body.length)throw new Error('BIN object size does not match its fields.');
  return read.fields;
}

/** The field named `name` among `list` (a structure's fields), or undefined. */
export function field(list,name){
  const hash=binHash(name);
  return list?.find(row=>row.hash===hash);
}

/** The fields of a structure value, or an empty list for anything else. */
export const structFields=value=>(value?.kind===POINTER||value?.kind===EMBED)&&value.value?value.value.fields:[];

export const KIND={STRING,HASH,LINK,LIST,LIST2,POINTER,EMBED,OPTION,MAP};
