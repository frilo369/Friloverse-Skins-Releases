// Riot skins' sound: checks moveAudioToBase against the installed League, and against Rose's
// packages where given (their sound is known to work).
// Usage (bundled Node 24, for zstd): node scripts/verify-skin-audio.mjs [--all] [rose.fantome ...]
// With --all, every League skin: every event a removed tag reached must be reachable by the
// base tag, and no name LTK Manager's check looks at may name another skin. Rose's packages
// can be from another patch than this League, so a difference there needs reading, not trust.
import {readdir} from 'node:fs/promises';
import path from 'node:path';
import {archiveFiles} from '../src/custom-skin-compat.mjs';
import {leagueFolder} from '../src/league-client.mjs';
import {baseAudioTag,leagueBanks,moveAudioToBase,wwiseHash} from '../src/skin-audio.mjs';
import {baseSkinName,renameBaseSkin} from '../src/bin-compat.mjs';
import {binHash,parseBin,readWadFile,readWadFilesOnDisk,writeBin} from '../src/skin-slots.mjs';
import {ensureZstdRuntime} from './lib/runtime.mjs';

ensureZstdRuntime(import.meta.url);
const args=process.argv.slice(2),all=args.includes('--all'),packages=args.filter(arg=>arg!=='--all');
const league=await leagueFolder();
if(!league)throw new Error('League is not installed here.');
const folder=path.join(league,'Game','DATA','FINAL','Champions');
const mainWads=(await readdir(folder)).filter(name=>/^[A-Za-z0-9]+\.wad\.client$/.test(name));
const championOf=new Map(mainWads.map(name=>[name.split('.')[0].toLowerCase(),name.split('.')[0]]));
const u32=value=>{const out=Buffer.alloc(4);out.writeUInt32LE(value>>>0);return out;};

/** League's skinN object on the base slot, as the builder keys it before the audio moves. */
function onBaseSlot(skin,alias,number,name){
  const bin=parseBin(skin),source=binHash(`characters/${alias}/skins/skin${number}`),resources=binHash(`characters/${alias}/skins/skin${number}/resources`);
  const target=binHash(`characters/${alias}/skins/skin0`),targetResources=binHash(`characters/${alias}/skins/skin0/resources`);
  const objects=bin.objects.filter(row=>row.hash===source||row.hash===resources).map(row=>{
    const body=Buffer.from(row.body);body.writeUInt32LE(row.hash===source?target:targetResources,0);
    return {type:row.type,hash:body.readUInt32LE(0),body};
  });
  const moved=writeBin({...bin,dependencies:[],objects});
  return renameBaseSkin(moved,alias,name)||moved;
}
const strings=bytes=>{
  const out=[];
  for(let at=0;at+2<bytes.length;at++){
    const size=bytes.readUInt16LE(at);
    if(size<3||size>200||at+2+size>bytes.length)continue;
    const text=bytes.toString('latin1',at+2,at+2+size);
    if(/^[A-Za-z0-9_/.\- ]+$/.test(text)){out.push(text);at+=1+size;}
  }
  return out;
};
/** The skin's audio labels (tags, unit names, events), or its bank paths. */
function audioLabels(bytes,alias,paths=false){
  const key=binHash(`characters/${alias}/skins/skin0`),body=parseBin(bytes).objects.find(row=>row.hash===key)?.body;
  const needle=Buffer.concat([u32(binHash('SkinAudioProperties')),Buffer.from([131])]);
  const at=body?.indexOf(needle)??-1;
  if(at<0)return [];
  const all=strings(body.subarray(at+5,at+5+8+body.readUInt32LE(at+9)));
  return all.filter(text=>paths===/\.(bnk|wpk)$/i.test(text));
}
const hircOf=bank=>{
  let at=0;
  while(at+8<=bank.length){
    const size=bank.readUInt32LE(at+4);
    if(bank.toString('latin1',at,at+4)==='HIRC'){
      const out=[];let cursor=at+12;
      for(let i=bank.readUInt32LE(at+8);i>0;i--){const length=bank.readUInt32LE(cursor+1);out.push({type:bank[cursor],id:bank.readUInt32LE(cursor+5),raw:bank.subarray(cursor,cursor+5+length)});cursor+=5+length;}
      return out;
    }
    at+=8+size;
  }
  return [];
};

let failures=0;
const fail=message=>{failures++;console.log(`  FAIL ${message}`);};

// Rose's packages, built the same way from the installed League, member by member.
for(const file of packages){
  const id=Number(path.basename(file).split('.')[0]);
  const wadRow=(await archiveFiles(file)).find(row=>/^wad\/[a-z0-9]+\.wad\.client$/i.test(row.name)&&!/^wad\/(common|ui)\./i.test(row.name));
  const alias=wadRow.name.split('/')[1].split('.')[0].toLowerCase(),champion=championOf.get(alias),number=id%1000;
  const baseFile=`data/characters/${alias}/skins/skin0.bin`,skinFile=`data/characters/${alias}/skins/skin${number}.bin`;
  const members=await readWadFilesOnDisk(path.join(folder,`${champion}.wad.client`),[baseFile,skinFile]);
  const name=baseSkinName(members.get(baseFile),alias);
  const built=await moveAudioToBase({bytes:onBaseSlot(members.get(skinFile),alias,number,name),alias,base:members.get(baseFile),read:leagueBanks(league,champion)});
  const rose=readWadFile(wadRow.bytes,baseFile);
  console.log(`\n${path.basename(file)} (${champion} ${number}): ${built.files.length} bank(s)`);
  const labels=bytes=>audioLabels(bytes,alias).map(text=>text.toLowerCase());
  const mine=labels(built.bytes),theirs=labels(rose);
  const missing=theirs.filter(text=>!mine.includes(text)),extra=mine.filter(text=>!theirs.includes(text));
  console.log(`  labels: ${mine.length} against Rose's ${theirs.length}; missing ${missing.length}, extra ${extra.length}`);
  if(missing.length)console.log('   missing',missing.slice(0,6).join(', '));
  if(extra.length)console.log('   extra',extra.slice(0,6).join(', '));
  const banks=bytes=>audioLabels(bytes,alias,true).join('\n    ');
  if(banks(built.bytes)!==banks(rose))console.log(`  bank lists differ:\n    ${banks(built.bytes)}\n   Rose:\n    ${banks(rose)}`);
  for(const {file:bank,bytes} of built.files){
    const other=readWadFile(wadRow.bytes,bank.toLowerCase());
    if(!other){fail(`Rose has no ${bank}`);continue;}
    const key=rows=>rows.map(row=>`${row.type}:${row.raw.toString('hex')}`);
    const left=key(hircOf(bytes)),right=key(hircOf(other)),rightSet=new Set(right),leftSet=new Set(left);
    const onlyHere=left.filter(row=>!rightSet.has(row)).length,onlyRose=right.filter(row=>!leftSet.has(row)).length;
    console.log(`  ${path.basename(bank)}: ${left.length} objects against ${right.length}; only here ${onlyHere}, only Rose ${onlyRose}, header ${bytes.subarray(0,24).equals(other.subarray(0,24))}`);
    if(onlyRose)fail(`${bank} lacks what Rose has`);
  }
  if(missing.length)fail('labels differ');
}

// Every skin in League.
if(all){
  let absent=0,skins=0,moved=0,events=0,silent=0,flagged=0,banks=0;
  for(const wad of mainWads){
    const champion=wad.split('.')[0],alias=champion.toLowerCase(),read=leagueBanks(league,champion);
    const files=Array.from({length:130},(_,number)=>`data/characters/${alias}/skins/skin${number}.bin`);
    const members=await readWadFilesOnDisk(path.join(folder,wad),files);
    const base=members.get(files[0]),name=base&&baseSkinName(base,alias);
    if(!name)continue;
    const tag=baseAudioTag(base,alias);
    for(const [index,file] of files.entries()){
      const skin=members.get(file);
      if(!index||!skin)continue;
      skins++;
      const before=onBaseSlot(skin,alias,index,name);
      const built=await moveAudioToBase({bytes:before,alias,base,read});
      // LTK Manager's rule: a tag or SFX unit name must not name a skin of this champion.
      const skinName=new RegExp(`^${alias}skin0*[1-9]\\d*$`,'i'),unitName=new RegExp(`^${alias}_skin0*[1-9]\\d*_sfx`,'i');
      const named=audioLabels(built.bytes,alias).filter(row=>skinName.test(row)||unitName.test(row));
      if(named.length){flagged++;console.log(`${champion} ${index}: still names ${named.join(', ')}`);}
      if(built.bytes===before)continue;
      moved++;banks+=built.files.length;
      const added=new Set(built.files.flatMap(row=>hircOf(row.bytes).filter(item=>item.type===4).map(item=>item.id)));
      const labels=audioLabels(before,alias),existing=new Set();
      for(const bank of audioLabels(before,alias,true).filter(row=>/_events\.bnk$/i.test(row))){
        for(const item of hircOf(await read(bank)||Buffer.alloc(0)))if(item.type===4)existing.add(item.id);
      }
      for(const own of labels.filter(row=>skinName.test(row))){
        const needle=new RegExp(`_${own}_`,'i');
        for(const event of labels.filter(row=>needle.test(row))){
          events++;
          const target=event.replace(needle,`_${tag}_`);
          if(added.has(wwiseHash(target))||existing.has(wwiseHash(target)))continue;
          if(existing.has(wwiseHash(event))){silent++;if(silent<=20)console.log(`${champion} ${index}: ${event} is in a bank but has no ${target}`);}
          else absent++;
        }
      }
    }
  }
  console.log(`\nAll of League: ${skins} skins, ${moved} moved, ${banks} banks written, ${events} tagged events, ${silent} in a bank with no base-tag event, ${absent} listed but in no bank (silent in League too), ${flagged} still naming a skin.`);
  if(flagged||silent)failures++;
}
if(failures){console.log(`\n${failures} failure(s).`);process.exitCode=1;}
else console.log('\nPassed.');
