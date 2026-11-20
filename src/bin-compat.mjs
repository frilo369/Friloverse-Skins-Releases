import {binHash,parseBin} from './skin-slots.mjs';

const NAME=binHash('ChampionSkinName'),SKIN=binHash('SkinCharacterDataProperties');
const WIDTHS=new Map([[0,0],[1,1],[2,1],[3,1],[4,2],[5,2],[6,4],[7,4],[8,8],[9,8],[10,4],[11,8],[12,12],[13,16],[14,64],[15,4],[18,8],[132,4],[135,1]]);
const decoder=new TextDecoder('utf-8',{fatal:true});

// Layouts follow ltk_meta 0.9.1's Kind::unpack and Cursor::skip_value. Complex
// values are skipped by their declared size; only direct properties are eligible.
function kind(raw,legacy){
  if(legacy){
    if(raw>=18&&raw<128)raw=(raw-18)|128;
    if(raw>=129)raw++;
  }
  if(WIDTHS.has(raw)||raw===16||raw===17||raw>=128&&raw<=134)return raw;
  return null;
}

function directFields(body,legacy){
  if(body.length<6)return null;
  const count=body.readUInt16LE(4);
  if(count>4096||count*5>body.length-6)return null;
  let budget=body.length*16+1024;
  const fits=(at,size)=>Number.isSafeInteger(size)&&at>=0&&at+size<=body.length;
  function ends(type,at,depth=0){
    if(--budget<0||depth>64)return [];
    if(WIDTHS.has(type)){const size=WIDTHS.get(type);return fits(at,size)?[at+size]:[];}
    if(type===17)return [4,8].filter(size=>fits(at,size)).map(size=>at+size);
    if(type===16){
      if(!fits(at,2))return [];
      const size=body.readUInt16LE(at);
      return fits(at+2,size)?[at+2+size]:[];
    }
    if(type===128||type===129||type===134){
      const kinds=type===134?2:1;
      if(!fits(at,kinds+4))return [];
      for(let i=0;i<kinds;i++)if(kind(body[at+i],legacy)===null)return [];
      const size=body.readUInt32LE(at+kinds),start=at+kinds+4;
      return size>=4&&fits(start,size)?[start+size]:[];
    }
    if(type===130||type===131){
      if(!fits(at,4))return [];
      if(body.readUInt32LE(at)===0)return [at+4];
      if(!fits(at+4,4))return [];
      const size=body.readUInt32LE(at+4),start=at+8;
      return size>=2&&fits(start,size)?[start+size]:[];
    }
    if(type===133){
      if(!fits(at,2))return [];
      const item=kind(body[at],legacy),present=body[at+1];
      if(item===null||present>1)return [];
      return present?ends(item,at+2,depth+1):[at+2];
    }
    return [];
  }
  const failed=new Set();
  function walk(at,index){
    if(--budget<0)return null;
    if(index===count)return at===body.length?[]:null;
    const key=`${at}:${index}`;
    if(failed.has(key)||!fits(at,5))return null;
    const hash=body.readUInt32LE(at),type=kind(body[at+4],legacy),value=at+5;
    if(type===null||hash===NAME&&type!==16)return null;
    for(const end of ends(type,value)){
      const rest=walk(end,index+1);
      if(rest)return [{hash,type,value,end},...rest];
    }
    failed.add(key);return null;
  }
  return walk(6,0);
}

function locate(bytes,champion){
  if(!Buffer.isBuffer(bytes)||typeof champion!=='string'||!/^[a-z0-9]+$/i.test(champion))return null;
  try{
    const bin=parseBin(bytes);
    if(!bin)return null;
    const expected=binHash(`characters/${champion.toLowerCase()}/skins/skin0`);
    const objects=bin.objects.filter(row=>row.hash===expected);
    if(objects.length!==1||objects[0].type!==SKIN)return null;
    const object=objects[0];
    for(const legacy of [false,true]){
      const fields=directFields(object.body,legacy);
      if(!fields)continue;
      const matches=fields.filter(field=>field.hash===NAME);
      if(matches.length!==1)return null;
      const field=matches[0];
      const name=decoder.decode(object.body.subarray(field.value+2,field.end));
      return {object,field,name,fields};
    }
  }catch{/* An unsupported or truncated BIN is never edited. */}
  return null;
}

/** The direct ChampionSkinName of this champion's base-skin object, or null. */
export function baseSkinName(bytes,champion){return locate(bytes,champion)?.name??null;}

/** Direct properties of this champion's base-skin object, with raw values preserved. */
function skinPropertyEntries(bytes,champion,slot=0){
  if(!Buffer.isBuffer(bytes)||typeof champion!=='string'||!/^[a-z0-9]+$/i.test(champion)||!Number.isInteger(slot)||slot<0||slot>999)return null;
  const bin=parseBin(bytes),expected=binHash(`characters/${champion.toLowerCase()}/skins/skin${slot}`);
  const objects=bin?.objects.filter(row=>row.hash===expected&&row.type===SKIN)||[];
  if(objects.length!==1)return null;
  for(const legacy of [false,true]){
    const fields=directFields(objects[0].body,legacy);
    if(fields)return {object:objects[0],fields,bodyOffset:objects[0].body.byteOffset-bytes.byteOffset};
  }
  return null;
}

/** Direct properties of a skin object, with raw values preserved for comparison. */
export function skinProperties(bytes,champion,slot=0){
  const found=skinPropertyEntries(bytes,champion,slot);
  return found?.fields.map(({hash,type,value,end})=>({
    hash:hash.toString(16).padStart(8,'0'),type,
    value:found.object.body.subarray(value,end),
  }))??null;
}

const meshPaths=bytes=>[...new Set([...bytes.toString('latin1').matchAll(/ASSETS\/Characters\/[A-Za-z0-9_.\/-]+\.(?:skl|skn)/gi)].map(match=>match[0]))];
const particlePath=file=>/\/(?:particles|vfx|effects|sfx|trails?|missiles?)\//i.test(file);
const bodyModel=file=>/\/skins\/skin\d+\/(?:[^/]+\/)*[^/]+\.(?:skl|skn)$/i.test(file)&&!particlePath(file);
/** The body models under a skin folder; a form's own folder (`Skins/Skin77/Genre1`) counts,
 * a chroma's particle models (`.../Particles/`) do not. */
export function bodyMeshPaths(bytes,champion){
  const root=`assets/characters/${champion.toLowerCase()}/skins/`;
  return meshPaths(bytes).filter(file=>file.toLowerCase().startsWith(root)&&bodyModel(file));
}
/**
 * The audio labels of other skins, made the base skin's: `AhriSkin27` becomes
 * `AhriBase27` and `Ahri_Skin27_SFX` becomes `Ahri_Base27_SFX`. LTK Manager reads those
 * two names (SkinAudioProperties' tags and bank units) and refuses a base skin that
 * names another skin. The edits keep each string's length, so no container changes size.
 */
export function renameAudioNames(bytes,alias){
  const out=Buffer.from(bytes);
  const tag=new RegExp(`^${alias}skin0*[1-9]\\d*$`,'i'),unit=new RegExp(`^${alias}_skin0*[1-9]\\d*(?:_|$)`,'i');
  // Keep the authored casing: `AhriSkin27` becomes `AhriBase27`, not `Ahribase27`.
  const base=match=>match===match.toUpperCase()?'BASE':match[0]===match[0].toUpperCase()?'Base':'base';
  for(let at=0;at+2<=out.length;at++){
    const size=out.readUInt16LE(at);
    if(size<6||size>120||at+2+size>out.length)continue;
    const text=out.toString('latin1',at+2,at+2+size);
    if(!/^[A-Za-z0-9_]+$/.test(text))continue;
    if(!tag.test(text)&&!unit.test(text))continue;
    out.write(text.replace(/skin/i,base),at+2,'latin1');
  }
  return out;
}
function replaceEncodedString(value,from,to){
  const source=Buffer.from(from,'utf8'),target=Buffer.from(to,'utf8'),parts=[];
  let offset=0,changed=false;
  for(let at=value.indexOf(source,offset);at>=0;at=value.indexOf(source,offset)){
    if(at<2||value.readUInt16LE(at-2)!==source.length)throw new Error('Skin mesh path has an unexpected BIN string encoding.');
    parts.push(value.subarray(offset,at-2));
    const length=Buffer.alloc(2);length.writeUInt16LE(target.length);
    parts.push(length,target);offset=at+source.length;changed=true;
  }
  if(!changed)return null;
  parts.push(value.subarray(offset));
  const output=Buffer.concat(parts),oldSize=value.readUInt32LE(4),newSize=oldSize+output.length-value.length;
  if(value.length<8||oldSize!==value.length-8||newSize<0)throw new Error('Skin mesh field has an unexpected BIN container length.');
  output.writeUInt32LE(newSize,4);
  return output;
}

/**
 * The source skin's .skl/.skn files, each with the base-skin path that replaces it.
 * `lenient` keeps the paths that have no single base counterpart (a chroma's particle
 * models, which the game already ships under their own paths) instead of failing.
 */
export function meshPairs(bytes,baseBytes,champion,{lenient=false}={}){
  const allSourcePaths=meshPaths(bytes),allBasePaths=meshPaths(baseBytes);
  const prefix=`assets/characters/${champion.toLowerCase()}/skins/`;
  const sourcePaths=allSourcePaths.filter(file=>file.toLowerCase().startsWith(prefix)&&/\/skins\/skin\d+\/.+\.(?:skl|skn)$/i.test(file));
  const basePaths=allBasePaths.filter(file=>file.toLowerCase().startsWith(prefix)&&/\/skins\/base\/.+\.(?:skl|skn)$/i.test(file));
  if(!sourcePaths.length)return [];
  const relative=(file,kind)=>file.match(new RegExp(`^assets/characters/${champion}/skins/${kind}/(.+)$`,'i'))?.[1]||'';
  const replacements=[];
  for(const from of sourcePaths){
    const sourceRelative=relative(from,'skin\\d+'),directory=pathDirectory(sourceRelative).toLowerCase(),extension=pathExtension(sourceRelative);
    let candidates=basePaths.filter(file=>{
      const targetRelative=relative(file,'base');
      return pathDirectory(targetRelative).toLowerCase()===directory&&pathExtension(targetRelative)===extension;
    });
    // A form's body model sits in its own folder (`Skins/Skin77/Genre1/Sona_Skin77_Genre1`),
    // which the base skin has no same-named folder for: its one base model of that kind is
    // the body to replace. Particle models are never body models and stay where they are.
    if(candidates.length!==1&&directory&&bodyModel(from)){
      const byExtension=basePaths.filter(file=>{
        const targetRelative=relative(file,'base');
        return !pathDirectory(targetRelative)&&pathExtension(targetRelative)===extension;
      });
      if(byExtension.length===1)candidates=byExtension;
    }
    if(candidates.length!==1){
      if(lenient)continue;
      return null;
    }
    replacements.push([from,candidates[0]]);
  }
  return replacements.length||lenient?replacements:null;
}

/** Retarget only the source skin's .skl/.skn paths to its real base-skin assets. */
export function useBaseSkinMesh(bytes,champion,baseBytes,{lenient=false}={}){
  const source=skinPropertyEntries(bytes,champion,0),base=skinPropertyEntries(baseBytes,champion,0);
  if(!source||!base)return null;
  const replacements=meshPairs(bytes,baseBytes,champion,{lenient});
  if(!replacements)return null;
  if(!replacements.length)return bytes;
  const changedValues=new Map(),matched=new Set();
  for(const field of source.fields){
    if(field.type!==131)continue;
    let replacement=source.object.body.subarray(field.value,field.end),changed=false;
    for(const [from,to] of replacements){
      if(!replacement.toString('latin1').includes(from))continue;
      const next=replaceEncodedString(replacement,from,to);
      if(!next)return null;
      replacement=next;changed=true;matched.add(from);
    }
    if(changed)changedValues.set(field,replacement);
  }
  if(matched.size!==replacements.length)return null;
  const body=source.object.body;
  const parts=[];let cursor=0;
  for(const field of source.fields){
    const replacement=changedValues.get(field);
    if(!replacement)continue;
    parts.push(body.subarray(cursor,field.value),replacement);cursor=field.end;
  }
  if(!parts.length)return null;
  parts.push(body.subarray(cursor));
  const nextBody=Buffer.concat(parts);
  const size=Buffer.alloc(4);size.writeUInt32LE(nextBody.length);
  return Buffer.concat([
    bytes.subarray(0,source.bodyOffset-4),size,nextBody,
    bytes.subarray(source.bodyOffset+body.length),
  ]);
}

const pathDirectory=file=>{
  const at=file.lastIndexOf('/');return at<0?'':file.slice(0,at);
};
const pathExtension=file=>file.slice(file.lastIndexOf('.')+1).toLowerCase();

/**
 * Changes that one direct string property and its enclosing object's byte size.
 * The header, dependencies, every other object/field, and tail retain exact bytes.
 * Returns null for an absent/unsupported shape or a name that is already correct.
 */
export function renameBaseSkin(bytes,champion,baseName){
  if(typeof baseName!=='string'||!baseName||/[\u0000-\u001f]/.test(baseName))return null;
  const text=Buffer.from(baseName,'utf8');
  if(text.length>65535||text.toString('utf8')!==baseName)return null;
  const found=locate(bytes,champion);
  if(!found||found.name===baseName)return null;
  const {object,field}=found,length=Buffer.alloc(2);
  length.writeUInt16LE(text.length);
  const body=Buffer.concat([object.body.subarray(0,field.value),length,text,object.body.subarray(field.end)]);
  const size=Buffer.alloc(4);size.writeUInt32LE(body.length);
  const start=object.body.byteOffset-bytes.byteOffset;
  return Buffer.concat([bytes.subarray(0,start-4),size,body,bytes.subarray(start+object.body.length)]);
}
