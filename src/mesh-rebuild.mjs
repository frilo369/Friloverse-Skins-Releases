// Rebuilds a League skeleton (.skl) or mesh (.skn) so it is byte-distinct from the game's
// own file while drawing and animating the same, the way Rose's open-source base-skin
// pipeline does (injection/baseskin/mesh.py, MIT):
//   - a skeleton gets one more root joint, null_bone, at the origin with an identity bind
//     pose; no animation track or vertex uses it;
//   - a mesh gets one more vertex, a copy of its last one, added to its last submesh; no
//     triangle uses it.
// LTK Manager's in-game base-skin check compares the model at the base skin's path with the
// game's own skins. Handing it the selected skin's file unchanged is refused ("skin0 skeleton
// is one of <champion>'s other skins' meshes"); the rebuilt copy is not byte-identical, so the
// check passes while the model is the same. Every other byte is kept.
//
// League's skeletons are version 0 with a sorted joint table; its meshes are versions 4.1,
// 2.1, 1.1 and 0.1. A file this cannot read is refused instead of being altered.
const SKL_FORMAT_TOKEN=0x22FD4FC3,SKN_MAGIC=0x00112233;
export const NULL_JOINT_NAME='null_bone';
const SKL_HEADER_SIZE=64,SKL_VERSION=8,SKL_JOINT_COUNT=14,SKL_INFLUENCE_COUNT=16,SKL_SECTION_OFFSETS=20;
const SKL_JOINT_SIZE=100,JOINT_NAME_OFFSET=96,SKL_TABLE_ENTRY_SIZE=8,JOINT_RADIUS=2.1;
const SKN_RANGE_SIZE=80,RANGE_VERTEX_START=64,RANGE_VERTEX_COUNT=68;
const LEGACY_VERTEX_SIZE=52,SKN_BOUNDS_SIZE=40;
const IDENTITY=[0,0,0,1,1,1,0,0,0,1];

const plain=message=>Object.assign(new Error(message),{plain:true});
const u16=(data,at)=>at>=0&&at+2<=data.length?data.readUInt16LE(at):null;
const u32=(data,at)=>at>=0&&at+4<=data.length?data.readUInt32LE(at):null;
const i32=(data,at)=>at>=0&&at+4<=data.length?data.readInt32LE(at):null;

/** The ELF hash of a lowercased name, which League's skeleton joint table is sorted by. */
export function elfHashLower(name){
  let value=0;
  for(const byte of Buffer.from(String(name),'utf8')){
    const lower=byte>=65&&byte<=90?byte+32:byte;
    value=((value<<4)+lower)>>>0;
    const high=value&0xF0000000;
    if(high)value^=high>>>24;
    value=(value&(~high))>>>0;
  }
  return value>>>0;
}
const NULL_JOINT_HASH=elfHashLower(NULL_JOINT_NAME);

export const isSkeleton=data=>u32(data,4)===SKL_FORMAT_TOKEN;
export const isMesh=data=>u32(data,0)===SKN_MAGIC;

const section=(data,offset,length)=>{
  if(offset<=0)return null;
  const end=offset+length;
  return end<=data.length?[offset,end]:null;
};
const stringAt=(data,offset)=>{
  if(offset<0||offset>=data.length)return null;
  const end=data.indexOf(0,offset);
  return end<0?null:[offset,end+1];
};

class Skeleton{
  constructor(data){
    if(data.length<SKL_HEADER_SIZE)throw plain('The skeleton file is truncated.');
    const version=u32(data,SKL_VERSION);
    if(version!==0)throw plain('This skeleton version cannot be prepared.');
    const count=u16(data,SKL_JOINT_COUNT)||0;
    if(count===0||count>=0x7FFF)throw plain('This skeleton has an unexpected joint count.');
    const offsets=Array.from({length:6},(_,i)=>i32(data,SKL_SECTION_OFFSETS+4*i)||0);
    const joints=section(data,offsets[0],count*SKL_JOINT_SIZE);
    if(!joints)throw plain('The skeleton joints are out of bounds.');
    const table=section(data,offsets[1],count*SKL_TABLE_ENTRY_SIZE);
    if(!table)throw plain('The skeleton joint table is out of bounds.');
    if(joints[0]<table[1]&&table[0]<joints[1])throw plain('The skeleton sections overlap.');
    const strings=[];
    for(let i=0;i<count;i++){
      const field=joints[0]+i*SKL_JOINT_SIZE+JOINT_NAME_OFFSET;
      const found=stringAt(data,field+(i32(data,field)||0));
      if(!found)throw plain('A skeleton joint name is out of bounds.');
      strings.push(found);
    }
    for(const index of [3,4]){
      if(offsets[index]>0){
        const found=stringAt(data,offsets[index]);
        if(!found)throw plain('The skeleton name is out of bounds.');
        strings.push(found);
      }
    }
    let influences=null;
    if(offsets[2]>0){
      const influenceCount=u32(data,SKL_INFLUENCE_COUNT)||0;
      influences=section(data,offsets[2],influenceCount*2);
      if(!influences)throw plain('The skeleton influences are out of bounds.');
    }
    this.count=count;this.offsets=offsets;this.joints=joints;this.table=table;this.strings=strings;
    this.sections=[joints,table,...(influences?[influences]:[]),...strings];
    this.contentEnd=Math.max(...this.sections.map(([,end])=>end));
  }
  hashes(data){
    const out=[];
    for(let at=this.table[0];at<this.table[1];at+=SKL_TABLE_ENTRY_SIZE)out.push(u32(data,at+4));
    return out;
  }
}

const nullJoint=(jointId,nameHash,nameOffset)=>{
  const out=Buffer.alloc(SKL_JOINT_SIZE);
  out.writeUInt16LE(0,0);
  out.writeInt16LE(jointId,2);
  out.writeInt16LE(-1,4);
  out.writeInt16LE(0,6);
  out.writeUInt32LE(nameHash,8);
  out.writeFloatLE(JOINT_RADIUS,12);
  for(let i=0;i<IDENTITY.length;i++)out.writeFloatLE(IDENTITY[i],16+i*4);
  for(let i=0;i<IDENTITY.length;i++)out.writeFloatLE(IDENTITY[i],56+i*4);
  out.writeInt32LE(nameOffset,96);
  return out;
};

function addNullJoint(data){
  const skeleton=new Skeleton(data);
  const {count,joints,table}=skeleton;
  const jointInsert=joints[1],tableInsert=table[1];
  for(const [start,end] of skeleton.sections)if(jointInsert>start&&jointInsert<end||tableInsert>start&&tableInsert<end)throw plain('The skeleton sections overlap.');
  const entries=[];
  for(let at=table[0];at<table[1];at+=SKL_TABLE_ENTRY_SIZE)entries.push(data.subarray(at,at+SKL_TABLE_ENTRY_SIZE));
  if(entries.some(entry=>u32(entry,4)===NULL_JOINT_HASH))throw plain('The skeleton already has a null joint.');
  const tail=data.subarray(skeleton.contentEnd);
  const bodyEnd=tail.length<4&&tail.every(byte=>byte===0)?skeleton.contentEnd:data.length;
  const moved=at=>at+(at>=jointInsert?SKL_JOINT_SIZE:0)+(at>=tableInsert?SKL_TABLE_ENTRY_SIZE:0);
  const inserts=[[jointInsert,SKL_JOINT_SIZE],[tableInsert,SKL_TABLE_ENTRY_SIZE]].sort((a,b)=>a[0]-b[0]);
  const parts=[];let copied=0;
  for(const [at,length] of inserts){
    parts.push(data.subarray(copied,at),Buffer.alloc(length));copied=at;
  }
  parts.push(data.subarray(copied,bodyEnd));
  const name=Buffer.from(NULL_JOINT_NAME,'ascii');
  parts.push(name,Buffer.from([0]));
  let out=Buffer.concat(parts);
  const padding=(4-(out.length%4))%4;
  if(padding)out=Buffer.concat([out,Buffer.alloc(padding)]);
  out.writeUInt32LE(out.length,0);
  out.writeUInt16LE(count+1,SKL_JOINT_COUNT);
  for(let i=0;i<skeleton.offsets.length;i++)if(skeleton.offsets[i]>0)out.writeInt32LE(moved(skeleton.offsets[i]),SKL_SECTION_OFFSETS+4*i);
  for(let i=0;i<count;i++){
    const field=moved(joints[0]+i*SKL_JOINT_SIZE+JOINT_NAME_OFFSET);
    out.writeInt32LE(moved(skeleton.strings[i][0])-field,field);
  }
  const jointAt=moved(jointInsert)-SKL_JOINT_SIZE;
  nullJoint(count,NULL_JOINT_HASH,0).copy(out,jointAt);
  const nameAt=out.length-padding-name.length-1;
  out.writeInt32LE(nameAt-(jointAt+JOINT_NAME_OFFSET),jointAt+JOINT_NAME_OFFSET);
  const entry=Buffer.alloc(SKL_TABLE_ENTRY_SIZE);
  entry.writeInt16LE(count,0);entry.writeInt16LE(0,2);entry.writeUInt32LE(NULL_JOINT_HASH,4);
  let position=entries.findIndex(other=>u32(other,4)>NULL_JOINT_HASH);
  if(position<0)position=entries.length;
  entries.splice(position,0,entry);
  const start=moved(table[0]);
  Buffer.concat(entries).copy(out,start);
  return out;
}

class Mesh{
  constructor(data){
    const major=u16(data,4);
    if(major===null)throw plain('The mesh file is truncated.');
    let at=8,lastRange=null;
    if([1,2,4].includes(major)){
      const rangeCount=u32(data,at);
      if(rangeCount===null)throw plain('The mesh file is truncated.');
      at+=4;
      if(rangeCount>0)lastRange=at+(rangeCount-1)*SKN_RANGE_SIZE;
      at+=rangeCount*SKN_RANGE_SIZE;
      if(major===4)at+=4;
    }else if(major!==0)throw plain('This mesh version cannot be prepared.');
    const indexCount=u32(data,at),vertexCount=u32(data,at+4);
    if(indexCount===null||vertexCount===null)throw plain('The mesh file is truncated.');
    this.vertexCountAt=at+4;at+=8;
    let vertexSize=LEGACY_VERTEX_SIZE;
    if(major===4){
      vertexSize=u32(data,at);
      if(vertexSize===null)throw plain('The mesh file is truncated.');
      at+=8+SKN_BOUNDS_SIZE;
    }
    if(vertexCount===0||vertexSize===0)throw plain('The mesh has no vertices.');
    this.indicesAt=at;this.indexCount=indexCount;this.vertexCount=vertexCount;this.vertexSize=vertexSize;
    this.verticesEnd=at+indexCount*2+vertexCount*vertexSize;
    if(this.verticesEnd>data.length)throw plain('The mesh file is truncated.');
    this.lastRange=lastRange;
  }
}

function addNullVertex(data){
  const mesh=new Mesh(data);
  const {verticesEnd:end,vertexSize:size}=mesh;
  const out=Buffer.concat([data.subarray(0,end),data.subarray(end-size,end),data.subarray(end)]);
  out.writeUInt32LE(mesh.vertexCount+1,mesh.vertexCountAt);
  if(mesh.lastRange!==null){
    const start=u32(data,mesh.lastRange+RANGE_VERTEX_START),count=u32(data,mesh.lastRange+RANGE_VERTEX_COUNT);
    if(start===null||count===null)throw plain('The mesh file is truncated.');
    if(start+count===mesh.vertexCount)out.writeUInt32LE(count+1,mesh.lastRange+RANGE_VERTEX_COUNT);
  }
  return out;
}

/** A skeleton or mesh rebuilt so it is not byte-identical to the game's, but draws the same. */
export function rebuildMesh(data){
  if(isSkeleton(data))return addNullJoint(data);
  if(isMesh(data))return addNullVertex(data);
  throw plain('This model is neither a League skeleton nor a mesh.');
}

/** Whether this file is already a rebuild (a skeleton holding null_bone, or a copied last vertex). */
export function isRebuilt(data){
  try{
    if(isSkeleton(data))return new Skeleton(data).hashes(data).includes(NULL_JOINT_HASH);
    if(isMesh(data)){
      const mesh=new Mesh(data);
      if(mesh.vertexCount<2)return false;
      const end=mesh.verticesEnd,size=mesh.vertexSize;
      if(!data.subarray(end-size,end).equals(data.subarray(end-2*size,end-size)))return false;
      const last=mesh.vertexCount-1;
      for(let at=mesh.indicesAt;at<mesh.indicesAt+mesh.indexCount*2;at+=2)if(data.readUInt16LE(at)===last)return false;
      return true;
    }
  }catch{/* Not a file this understands. */}
  return false;
}
