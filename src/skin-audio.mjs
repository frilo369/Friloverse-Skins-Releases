import {createHash} from 'node:crypto';
import {readdir,readFile} from 'node:fs/promises';
import path from 'node:path';
import {renameAudioNames} from './bin-compat.mjs';
import {binHash,parseBin,readWadFilesOnDisk,writeBin} from './skin-slots.mjs';

// A skin goes in on the base skin's slot, and LTK Manager refuses a base skin whose audio
// tags or units name another skin. But the game plays `Play_sfx_<tag>_<what>` for the tags
// the skin lists, so taking `AhriSkin27` away leaves every `Play_sfx_AhriSkin27_...` event
// unreached: the skin is silent. So, as Rose's library does, each of those events also goes
// into the event bank under the base tag (`Play_sfx_Ahri_...`). The originals stay, as the
// game's animation and effect files name them directly.

const AUDIO=binHash('SkinAudioProperties'),SKIN=binHash('SkinCharacterDataProperties');
const TAGS=binHash('TagEventList'),UNITS=binHash('BankUnits'),NAME=binHash('Name'),PATHS=binHash('BankPath'),EVENTS=binHash('Events');
const STRING=16,LISTS=new Set([128,129]),EMBEDS=new Set([130,131]);
const WIDTHS=new Map([[1,1],[2,1],[3,1],[4,2],[5,2],[6,4],[7,4],[8,8],[9,8],[10,4],[11,8],[12,12],[13,16],[14,64],[15,4],[17,4],[18,8],[132,4],[135,1]]);
const WWISE_EVENT=4,WWISE_ACTION=3;
const u16=value=>{const out=Buffer.alloc(2);out.writeUInt16LE(value);return out;};
const u32=value=>{const out=Buffer.alloc(4);out.writeUInt32LE(value>>>0);return out;};

/** FNV-1 of the lower-case text: how Wwise names events and banks. */
export function wwiseHash(text){
  let hash=0x811c9dc5;
  for(const byte of Buffer.from(String(text).toLowerCase(),'utf8'))hash=(Math.imul(hash,0x01000193)^byte)>>>0;
  return hash;
}

function readValue(bytes,at,type){
  if(WIDTHS.has(type))return {type,end:at+WIDTHS.get(type)};
  if(type===STRING){
    const size=bytes.readUInt16LE(at);
    return {type,text:bytes.toString('utf8',at+2,at+2+size),end:at+2+size};
  }
  if(LISTS.has(type)){
    const item=bytes[at],size=bytes.readUInt32LE(at+1),count=bytes.readUInt32LE(at+5),items=[];
    let cursor=at+9;
    for(let i=0;i<count;i++){const value=readValue(bytes,cursor,item);items.push(value);cursor=value.end;}
    if(cursor!==at+5+size)throw new Error('A list does not end where it says.');
    return {type,item,items,end:cursor};
  }
  if(EMBEDS.has(type)){
    const name=bytes.readUInt32LE(at);
    if(!name)return {type,name,fields:[],end:at+4};
    const size=bytes.readUInt32LE(at+4),count=bytes.readUInt16LE(at+8),fields=[];
    let cursor=at+10;
    for(let i=0;i<count;i++){
      const hash=bytes.readUInt32LE(cursor),kind=bytes[cursor+4],start=cursor+5,value=readValue(bytes,start,kind);
      fields.push({hash,kind,start,value});cursor=value.end;
    }
    if(cursor!==at+8+size)throw new Error('A structure does not end where it says.');
    return {type,name,fields,end:cursor};
  }
  if(type===133){
    const value=bytes[at+1]?readValue(bytes,at+2,bytes[at]):null;
    return {type,end:value?value.end:at+2};
  }
  if(type===134){
    const size=bytes.readUInt32LE(at+2);
    return {type,end:at+6+size};
  }
  throw new Error(`Property type ${type} is not one this reader knows.`);
}
const writeString=text=>{const out=Buffer.from(text,'utf8');return Buffer.concat([u16(out.length),out]);};
const writeStrings=items=>{
  const body=Buffer.concat([u32(items.length),...items.map(writeString)]);
  return Buffer.concat([Buffer.from([STRING]),u32(body.length),body]);
};
function writeEmbed(name,fields){
  const body=Buffer.concat([u16(fields.length),...fields.map(({hash,kind,bytes})=>Buffer.concat([u32(hash),Buffer.from([kind]),bytes]))]);
  return Buffer.concat([u32(name),u32(body.length),body]);
}
const stringsOf=value=>LISTS.has(value?.type)&&value.item===STRING?value.items.map(row=>row.text):null;

/** The skin object's audio field, or null for a shape this does not know. */
function audioField(body){
  const count=body.readUInt16LE(4);
  let cursor=6;
  for(let i=0;i<count;i++){
    const hash=body.readUInt32LE(cursor),kind=body[cursor+4],start=cursor+5;
    if(hash===AUDIO&&!EMBEDS.has(kind))return null;
    const value=readValue(body,start,kind);
    if(hash===AUDIO)return {kind,start,value};
    cursor=value.end;
  }
  return null;
}

/** The active League client locale (`en_US`, `ko_KR`, ...) from LeagueClientSettings.yaml, or null. */
export async function clientLocale(league){
  try{
    const text=await readFile(path.join(league,'Config','LeagueClientSettings.yaml'),'utf8');
    const match=/^[ \t]+globals:[ \t]*\r?\n(?:[ \t]+(?!locale:)[\w-]+:.*\r?\n)*?[ \t]+locale:[ \t]*"?([A-Za-z]{2}_[A-Za-z]{2})"?/m.exec(text);
    return match?.[1]||null;
  }catch{return null;}
}

/** All tags League's base skin lists in `skin0.bin`, or `[alias]` when unreadable. */
export function baseAudioTags(base,alias){
  try{
    const key=binHash(`characters/${alias}/skins/skin0`);
    const object=parseBin(base)?.objects.find(row=>row.hash===key&&row.type===SKIN);
    const field=object&&audioField(object.body);
    const tags=stringsOf(field?.value.fields.find(row=>row.hash===TAGS)?.value)?.filter(Boolean)||[];
    return tags.length?tags:[alias];
  }catch{return [alias];}
}

/**
 * The tag League's base skin plays its events under. Not ChampionSkinName: Lee Sin's name is
 * `BaseBlindMonk` and his tag is `LeeSin`. Azir and Gangplank list a second tag beside it;
 * the highest-priority tag is the last one listed.
 */
export function baseAudioTag(base,alias){
  const tags=baseAudioTags(base,alias);
  return tags.find(tag=>tag.toLowerCase()===alias)||tags[tags.length-1]||alias;
}

// A tag can carry a suffix after the skin number (`SonaSkin06Genre01`) or a companion
// prefix before it (`SonaDJGenre01Skin06`); both name another skin and are refused.
const skinTag=(tag,alias)=>new RegExp(`^${alias}[a-z0-9]*(?:skin|base)0*[1-9]\\d*`,'i').test(tag);
// `_base27_` is what older converted packages carry, whose tags were only relabelled.
const skinUnit=alias=>new RegExp(`^(${alias})_(?:skin|base)0*[1-9]\\d*(?=_|$)`,'i');
const skinEvent=alias=>new RegExp(`(?:^|[^a-z0-9])${alias}[a-z0-9]*?_?skin0*([1-9]\\d*)(?=[^0-9]|$)`,'i');
const skinBankPath=/\/skins\/skin0*[1-9]\d*\//i;
const eventBank=file=>/_events\.bnk$/i.test(file);
const hasLocale=file=>/\/vo\/[a-z]{2}_[a-z]{2}\//i.test(file);

/**
 * Plans the skin's audio for the base slot: its own tags go, its units take the base skin's
 * names, and each event of a tag that went gains the base tag's name too. When two tags have
 * the same event the later one wins, as a later tag's event is the one the game plays.
 */
function planAudio(field,alias,baseTag,{strictBase=false}={}){
  const tagsField=field.value.fields.find(row=>row.hash===TAGS),unitsField=field.value.fields.find(row=>row.hash===UNITS);
  const tags=stringsOf(tagsField?.value),units=unitsField?.value;
  if(!tags||!LISTS.has(units?.type)||!EMBEDS.has(units.item))return null;
  const gone=tags.filter(tag=>skinTag(tag,alias));
  const unitName=skinUnit(alias),foreign=skinEvent(alias);
  const rows=[];
  let namesSkin=false,hasSkinEvents=false,hasSkinPaths=false;
  for(const unit of units.items){
    const name=unit.fields.find(row=>row.hash===NAME)?.value.text||'';
    const paths=stringsOf(unit.fields.find(row=>row.hash===PATHS)?.value)||[],events=stringsOf(unit.fields.find(row=>row.hash===EVENTS)?.value)||[];
    const renamed=unitName.test(name);
    if(renamed)namesSkin=true;
    if(events.some(event=>foreign.test(event)))hasSkinEvents=true;
    if(paths.some(file=>skinBankPath.test(file)||foreign.test(file)))hasSkinPaths=true;
    rows.push({unit,name:name.replace(unitName,'$1_Base'),renamed,paths,events,clones:[]});
  }
  if(!gone.length&&!namesSkin&&!(strictBase&&(hasSkinEvents||hasSkinPaths)))return null;
  const numbers=[];
  for(const tag of gone){
    const number=tag.match(/(?:skin|base)0*([1-9]\d*)/i)?.[1];
    if(number)numbers.push(number);
  }
  // Custom skins whose tags were already stripped (e.g. by an earlier pass) can still carry
  // skin-named events; infer their skin number(s) so those events get base-tag clones too.
  if(strictBase&&!numbers.length){
    const seen=new Set();
    for(const row of rows)for(const event of row.events){
      const number=foreign.exec(event)?.[1];
      if(number&&!seen.has(number)){seen.add(number);numbers.push(number);}
    }
  }
  const owner=new Map();
  for(const number of numbers){
    // A companion's events carry the skin's number too: `ShacoBoxSkin54` is `ShacoBox`'s.
    // The skin part can start the string (`SonaSkin77Blue_...`) or follow an underscore
    // (`sona_skin77_Blue_...`), so the boundary and optional separator are kept. The prefix
    // stops at the first skin token: an event that names the skin twice
    // (`AhriSkin04_AhriE_cast3DSkin04`) must have its first tag moved, not its last.
    const source=new RegExp(`(^|[^a-z0-9])(${alias}[a-z0-9]*?)_?(?:skin|base)0*${number}(?=[^0-9]|$)`,'i');
    for(const [index,row] of rows.entries())for(const event of row.events){
      const match=source.exec(event);
      if(!match)continue;
      const target=event.replace(source,(_whole,boundary,prefix)=>`${boundary}${prefix.toLowerCase()===alias.toLowerCase()?baseTag:prefix}`);
      owner.delete(target.toLowerCase());
      owner.set(target.toLowerCase(),{index,source:event,target});
    }
  }
  for(const clone of owner.values())rows[clone.index].clones.push(clone);
  return {tags,rows};
}

/** One bank's objects, BKHD version, and where its HIRC chunk sits. */
function readBank(bank){
  if(!Buffer.isBuffer(bank)||bank.length<12)return null;
  let at=0,version=134;
  while(at+8<=bank.length){
    const tag=bank.toString('latin1',at,at+4);
    const size=bank.readUInt32LE(at+4);
    if(at+8+size>bank.length)return null;
    if(tag==='BKHD'&&size>=4)version=bank.readUInt32LE(at+8);
    if(tag==='HIRC'){
      if(size<4)return null;
      const count=bank.readUInt32LE(at+8),objects=[];
      let cursor=at+12;
      const end=at+8+size;
      for(let i=0;i<count;i++){
        if(cursor+5>end)return null;
        const type=bank[cursor],length=bank.readUInt32LE(cursor+1);
        if(length<4||cursor+5+length>end)return null;
        objects.push({type,id:bank.readUInt32LE(cursor+5),raw:bank.subarray(cursor,cursor+5+length)});
        cursor+=5+length;
      }
      return {start:at,end,version,objects};
    }
    at+=8+size;
  }
  return null;
}
function writeHirc(bank,found,objects){
  const body=Buffer.concat([u32(objects.length),...objects.map(row=>row.raw)]);
  return Buffer.concat([bank.subarray(0,found.start),Buffer.from('HIRC','latin1'),u32(body.length),body,bank.subarray(found.end)]);
}
/** The bank with each event added again under another name, where it is not there yet. */
export function addBankEvents(bank,clones,{overwrite=false}={}){
  const found=readBank(bank);
  if(!found)return null;
  const objects=found.objects.map(row=>({...row}));
  const indexById=new Map(objects.map((row,index)=>[row.id,index]));
  const events=new Map(objects.filter(row=>row.type===WWISE_EVENT).map(row=>[row.id,row]));
  let changed=false;
  for(const {source,target} of clones){
    const event=events.get(wwiseHash(source)),id=wwiseHash(target);
    if(!event)continue;
    const existingIndex=indexById.get(id);
    if(existingIndex!==undefined){
      if(!overwrite||objects[existingIndex].type!==WWISE_EVENT)continue;
      const copy=Buffer.from(event.raw);copy.writeUInt32LE(id,5);
      if(copy.equals(objects[existingIndex].raw))continue;
      objects[existingIndex]={type:WWISE_EVENT,id,raw:copy};
      changed=true;
      continue;
    }
    const copy=Buffer.from(event.raw);copy.writeUInt32LE(id,5);
    indexById.set(id,objects.length);
    objects.push({type:WWISE_EVENT,id,raw:copy});
    changed=true;
  }
  return changed?writeHirc(bank,found,objects):null;
}
/** The bank with conflicting Wwise Event IDs removed (so a base bank cannot shadow a skin bank). */
export function removeBankEvents(bank,ids){
  if(!ids?.size)return null;
  const found=readBank(bank);
  if(!found)return null;
  const kept=found.objects.filter(row=>!(row.type===WWISE_EVENT&&ids.has(row.id)));
  return kept.length!==found.objects.length?writeHirc(bank,found,kept):null;
}
/** A language's actions are read through its bank's IDs, so its event bank's actions are all it needs. */
export function actionsOf(event,version=134){
  const raw=event.raw;
  if(raw.length<10)return [];
  let at=9,count=0;
  if(version<=122){
    if(at+4>raw.length)return [];
    count=raw.readUInt32LE(at);at+=4;
  }else{
    // Wwise BKHD > 122 encodes action count as a BIG-ENDIAN 7-bit varuint.
    for(let bytes=0;bytes<5&&at<raw.length;bytes++){
      const byte=raw[at++];
      count=((count<<7)|(byte&0x7f))>>>0;
      if(!(byte&0x80))break;
    }
  }
  if(at+count*4>raw.length)return [];
  return Array.from({length:count},(_,index)=>raw.readUInt32LE(at+index*4));
}
/**
 * A voice-over unit's own events are in the language's WAD, which a skin package cannot add
 * to for every language. So the new names go in one small bank of their own in the champion's
 * WAD: the events, and the actions they run, which reach the sounds by ID in the language's
 * banks. It belongs to no language, and its ID comes from its name, as Wwise's do.
 */
export function buildVoiceBank(bank,clones,name){
  const found=readBank(bank);
  if(!found)return null;
  const events=new Map(found.objects.filter(row=>row.type===WWISE_EVENT).map(row=>[row.id,row]));
  const actions=new Map(found.objects.filter(row=>row.type===WWISE_ACTION).map(row=>[row.id,row]));
  const used=new Map(),added=[],ids=new Set();
  for(const {source,target} of clones){
    const event=events.get(wwiseHash(source)),id=wwiseHash(target);
    if(!event||ids.has(id))continue;
    const needed=actionsOf(event,found.version);
    if(!needed.length||needed.some(action=>!actions.has(action)))continue;
    for(const action of needed)if(!used.has(action))used.set(action,actions.get(action).raw);
    const copy=Buffer.from(event.raw);copy.writeUInt32LE(id,5);
    added.push(copy);ids.add(id);
  }
  if(!added.length)return null;
  const body=Buffer.concat([u32(used.size+added.length),...used.values(),...added]);
  const header=Buffer.from(bank.subarray(0,found.start));
  header.writeUInt32LE(wwiseHash(name),12);
  header.writeUInt32LE(wwiseHash('SFX'),16);
  // The rest of the header identifies the bank's contents: this is a different bank.
  createHash('md5').update(body).digest().copy(header,header.readUInt32LE(4)+8-16);
  return Buffer.concat([header,Buffer.from('HIRC','latin1'),u32(body.length),body]);
}
// Rose's published packages put every bank the base skin replaces under the base skin's
// paths, and list only the base tag's events. The skin's own bank file moves with it.
const baseBankPath=file=>file.replace(/\/skins\/skin\d+\//i,'/Skins/Base/').replace(/skin\d+/gi,'Base');
const voiceBankPath=file=>file.replace(/\/vo\/[a-z]{2}_[a-z]{2}\//i,match=>match.slice(0,4)).replace(/_events\.bnk$/i,'_basetag_events.bnk');
const fileStem=file=>file.slice(file.lastIndexOf('/')+1).replace(/\.[^.]+$/,'');

/**
 * This champion's base-slot BIN with the skin's audio moved onto the base tag, and the event
 * banks that needs. `read` finds a bank by its path, or null. A bank that cannot be read costs
 * only that bank's sounds, never the skin, and makes `complete` false.
 */
export async function moveAudioToBase({bytes,alias,base,read,strictBase=false}){
  const none={bytes,files:[],localeFiles:[],complete:true};
  const bin=parseBin(bytes);
  const key=binHash(`characters/${alias}/skins/skin0`);
  const object=bin?.objects.find(row=>row.hash===key&&row.type===SKIN);
  if(!object)return none;
  const baseTag=baseAudioTag(base,alias);
  let field,plan;
  try{
    field=audioField(object.body);
    plan=field&&planAudio(field,alias,baseTag,{strictBase});
  }catch{
    // A shape a later patch brought. Quiet beats refused: a skin naming another skin would
    // turn off the whole overlay for the match.
    return {bytes:renameAudioNames(bytes,alias),files:[],localeFiles:[],complete:false};
  }
  if(!plan)return none;
  const files=new Map(),localeFiles=new Map(),merged=[];
  // A skin bank moving onto a base path another bank of this skin already uses (Choso
  // Vladimir lists its own `Skins/Base` SFX bank and a `Skin05` one) takes a free name beside
  // it instead of replacing it: Wwise tells banks apart by the ID inside, not by the path.
  const listed=new Set(plan.rows.flatMap(row=>row.paths.map(file=>file.toLowerCase())));
  const owner=new Map();
  const movedPath=file=>{
    const source=file.toLowerCase(),moved=baseBankPath(file);
    if(moved.toLowerCase()===source){owner.set(source,source);return moved;}
    let target=moved;
    for(let n=2;;n++){
      const key=target.toLowerCase(),taken=owner.get(key);
      if(taken===source||(!taken&&!listed.has(key)))break;
      target=moved.replace(/(_(?:events|audio)\.(?:bnk|wpk))$|(\.[^./]+)$/i,(match,tail,ext)=>`_${n}${tail||ext}`);
    }
    owner.set(target.toLowerCase(),source);
    return target;
  };
  let complete=true;
  for(const row of plan.rows){
    let paths=[...row.paths],events=[...row.events];
    if(strictBase){
      // Rose's package lists only the base tag's events and the base skin's bank paths; a
      // skin-tagged event that has no base alias is left out, not kept under its old name.
      const bySource=new Map(row.clones.map(clone=>[clone.source.toLowerCase(),clone.target]));
      const foreign=skinEvent(alias);
      const shown=new Set(),strictEvents=[];
      for(const event of row.events){
        const target=bySource.get(event.toLowerCase());
        const next=target??(foreign.test(event)?null:event);
        if(next&&!shown.has(next.toLowerCase())){shown.add(next.toLowerCase());strictEvents.push(next);}
      }
      const strictPaths=[],seenPaths=new Set();
      // A skin's `_VO_basetag_events.bnk` is kept and moved like any other bank: it holds the
      // voice events already named for the base tag (`Play_vo_Darius_Attack2DGarenSkin13`).
      for(const file of row.paths){
        const moved=movedPath(file),movedKey=moved.toLowerCase(),isMoved=movedKey!==file.toLowerCase();
        let bank=null;
        try{bank=await read(file);}catch{/* Read as missing. */}
        if(!bank){complete=false;continue;}
        let made=bank,sourced=[];
        const isEvent=row.clones.length>0&&eventBank(file);
        if(isEvent){
          const present=readBank(bank);
          const ids=present&&new Set(present.objects.filter(item=>item.type===WWISE_EVENT).map(item=>item.id));
          sourced=ids?row.clones.filter(clone=>ids.has(wwiseHash(clone.source))):[];
          const added=sourced.length?addBankEvents(bank,sourced,{overwrite:true}):null;
          if(added)made=added;
        }
        if(hasLocale(file)){
          // Localized VO files live in <Champion>.<locale>.wad.client. Keep the full event
          // bank (with all CAkSound/CAkRanSeqCntr nodes and added base-tag events) plus the
          // skin's own _audio.bnk/.wpk at Skins/Base/, so custom voice lines actually play.
          if(isEvent||isMoved){
            const existing=localeFiles.get(movedKey);
            const clones=isEvent?[...(existing?.clones||[]),...row.clones]:(existing?.clones||[]);
            localeFiles.set(movedKey,{source:file,file:moved,bytes:made,clones,event:Boolean(existing?.event||isEvent)});
          }
        }else files.set(movedKey,{file:moved,bytes:made,clones:sourced});
        if(!seenPaths.has(movedKey)){seenPaths.add(movedKey);strictPaths.push(moved);}
      }
      paths=strictPaths;events=strictEvents;
    }
    if(!strictBase&&row.clones.length){
      const clones=[...row.clones];
      for(const file of row.paths.filter(eventBank)){
        try{
          const bank=await read(file);
          const present=bank&&readBank(bank);
          if(!present){complete=false;continue;}
          const ids=new Set(present.objects.map(item=>item.id));
          const here=clones.filter(clone=>ids.has(wwiseHash(clone.source)));
          if(!here.length)continue;
          if(hasLocale(file)){
            const target=voiceBankPath(file),made=buildVoiceBank(bank,here,fileStem(target));
            if(!made)continue;
            files.set(target.toLowerCase(),{file:target,bytes:made});
            paths.splice(paths.indexOf(file)+1,0,target);
          }else{
            // The same bank may already have gained events from another unit.
            const made=addBankEvents(files.get(file.toLowerCase())?.bytes||bank,here);
            if(made)files.set(file.toLowerCase(),{file,bytes:made});
          }
          const listed=new Set(events.map(event=>event.toLowerCase()));
          events.push(...here.map(clone=>clone.target).filter(event=>!listed.has(event.toLowerCase())));
        }catch{complete=false;}
      }
    }
    // A skin's own units become one, except that League's own repeats of a unit stay as listed.
    const same=row.renamed?merged.find(item=>item.name===row.name):null;
    if(same){
      const havePaths=new Set(same.paths.map(file=>file.toLowerCase()));
      const haveEvents=new Set(same.events.map(event=>event.toLowerCase()));
      for(const file of paths)if(!havePaths.has(file.toLowerCase())){havePaths.add(file.toLowerCase());same.paths.push(file);}
      for(const event of events)if(!haveEvents.has(event.toLowerCase())){haveEvents.add(event.toLowerCase());same.events.push(event);}
    }else merged.push({name:row.name,paths,events,unit:row.unit});
  }
  // Remove conflicting base-tag event IDs from OTHER non-localized event banks so a base bank
  // loaded alongside a skin bank cannot shadow the skin's own cloned sounds.
  if(strictBase){
    const claimed=new Map();
    for(const [bankKey,entry] of files){
      for(const clone of entry.clones||[])claimed.set(wwiseHash(clone.target),bankKey);
    }
    if(claimed.size){
      for(const [bankKey,entry] of files){
        if(!eventBank(entry.file))continue;
        const drop=new Set();
        for(const [id,ownerKey] of claimed)if(ownerKey!==bankKey)drop.add(id);
        if(!drop.size)continue;
        const stripped=removeBankEvents(entry.bytes,drop);
        if(stripped)entry.bytes=stripped;
      }
    }
  }
  const baseTags=baseAudioTags(base,alias);
  const tags=plan.tags.filter(tag=>!skinTag(tag,alias));
  for(const tag of [...baseTags].reverse()){
    if(!tags.some(item=>item.toLowerCase()===tag.toLowerCase()))tags.unshift(tag);
  }
  const unitBytes=merged.map(({name,paths,events,unit})=>{
    const fields=unit.fields.map(item=>({
      hash:item.hash,kind:item.kind,
      bytes:item.hash===NAME?writeString(name):item.hash===PATHS?writeStrings(paths):item.hash===EVENTS?writeStrings(events):object.body.subarray(item.start,item.value.end),
    }));
    // League leaves the list out of a unit it only loads, which may have gained some here.
    if(events.length&&!fields.some(item=>item.hash===EVENTS))fields.push({hash:EVENTS,kind:128,bytes:writeStrings(events)});
    return writeEmbed(unit.name,fields);
  });
  const unitsBody=Buffer.concat([u32(unitBytes.length),...unitBytes]);
  const audio=writeEmbed(field.value.name,field.value.fields.map(item=>({
    hash:item.hash,kind:item.kind,
    bytes:item.hash===TAGS?writeStrings(tags):item.hash===UNITS?Buffer.concat([Buffer.from([item.value.item]),u32(unitsBody.length),unitsBody]):object.body.subarray(item.start,item.value.end),
  })));
  const body=Buffer.concat([object.body.subarray(0,field.start),audio,object.body.subarray(field.value.end)]);
  return {
    bytes:writeBin({...bin,objects:bin.objects.map(row=>row===object?{...row,body}:row)}),
    files:[...files.values()].map(({file,bytes})=>({file,bytes})),
    localeFiles:[...localeFiles.values()],
    complete,
  };
}

/**
 * Reads moved localized voice-over banks/packages for the active client language (or every
 * installed language WAD of `champion` when unknown), preserving League's exact WAD filename
 * casing (`FiddleSticks.en_US.wad.client`).
 * Note: League stores localized VO files under the `en_US` path hash in EVERY language WAD, so
 * we look up `entry.source` first and fall back to `/VO/<language>/` only if absent.
 */
export async function leagueLocaleWads(league,champion,localeFiles,{customSources=null,activeLocale=undefined}={}){
  if(!localeFiles?.length)return [];
  const folder=path.join(league,'Game','DATA','FINAL','Champions');
  let entries;
  try{entries=await readdir(folder);}catch{return [];}
  const pattern=new RegExp(`^${champion}\\.([a-z]{2}_[A-Z]{2})\\.wad\\.client$`,'i');
  const locale=activeLocale===undefined?await clientLocale(league):activeLocale;
  const matched=entries.filter(name=>pattern.test(name));
  const selected=locale&&matched.some(name=>name.match(pattern)?.[1]?.toLowerCase()===locale.toLowerCase())
    ?matched.filter(name=>name.match(pattern)?.[1]?.toLowerCase()===locale.toLowerCase())
    :matched;
  const out=[];
  for(const wadName of selected){
    const language=wadName.match(pattern)?.[1];
    if(!language)continue;
    const needed=localeFiles.filter(entry=>!customSources?.has(entry.source.toLowerCase()));
    const candidates=[];
    for(const entry of needed){
      candidates.push(entry.source);
      const localized=entry.source.replace(/\/vo\/[a-z]{2}_[a-z]{2}\//i,`/VO/${language}/`);
      if(localized.toLowerCase()!==entry.source.toLowerCase())candidates.push(localized);
    }
    let found=new Map();
    if(candidates.length)try{found=await readWadFilesOnDisk(path.join(folder,wadName),candidates);}catch{}
    const files=[];
    for(const entry of localeFiles){
      if(customSources?.has(entry.source.toLowerCase())){
        if(entry.bytes)files.push({file:entry.file,bytes:entry.bytes});
        continue;
      }
      const localized=entry.source.replace(/\/vo\/[a-z]{2}_[a-z]{2}\//i,`/VO/${language}/`);
      const raw=found.get(entry.source)??found.get(localized);
      if(!raw)continue;
      const bytes=entry.event&&entry.clones?.length?(addBankEvents(raw,entry.clones,{overwrite:true})||raw):raw;
      // Keep the path `skin0.bin` lists (en_US) when found at en_US, else localized.
      const target=found.get(entry.source)?entry.file:entry.file.replace(/\/vo\/[a-z]{2}_[a-z]{2}\//i,`/VO/${language}/`);
      files.push({file:target,bytes});
    }
    if(files.length)out.push({wadName,files});
  }
  return out;
}

/**
 * Finds a bank in the installed League: a champion's language WAD for voice-over (active
 * client locale first, trying `en_US` path first because League keeps `en_US` paths inside
 * every locale WAD), otherwise its main WAD.
 */
export function leagueBanks(league,champion){
  const folder=path.join(league,'Game','DATA','FINAL','Champions');
  let localeWads=null;
  return async file=>{
    try{
      if(!hasLocale(file))return (await readWadFilesOnDisk(path.join(folder,`${champion}.wad.client`),[file])).get(file)??null;
      if(!localeWads){
        const pattern=new RegExp(`^${champion}\\.([a-z]{2}_[A-Z]{2})\\.wad\\.client$`,'i');
        const all=(await readdir(folder)).map(name=>({name,language:name.match(pattern)?.[1]})).filter(item=>item.language);
        const preferred=await clientLocale(league);
        localeWads=preferred
          ?[...all.filter(item=>item.language.toLowerCase()===preferred.toLowerCase()),...all.filter(item=>item.language.toLowerCase()!==preferred.toLowerCase())]
          :all;
      }
      for(const {name,language} of localeWads){
        const localized=file.replace(/\/vo\/[a-z]{2}_[a-z]{2}\//i,`/VO/${language}/`);
        const wanted=localized.toLowerCase()===file.toLowerCase()?[file]:[file,localized];
        const found=await readWadFilesOnDisk(path.join(folder,name),wanted);
        const bytes=found.get(file)??found.get(localized);
        if(bytes)return bytes;
      }
    }catch{/* Read as missing. */}
    return null;
  };
}
