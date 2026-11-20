// Compare two Fantome packages without writing to either archive.
// Usage: node scripts/compare-skin-packages.mjs <champion> <reference.fantome> <candidate.fantome>
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import {archiveFiles} from '../src/custom-skin-compat.mjs';
import {baseSkinName} from '../src/bin-compat.mjs';
import {parseBin} from '../src/skin-slots.mjs';
import {xxh64} from '../src/league-icons.mjs';
import {ensureZstdRuntime} from './lib/runtime.mjs';

ensureZstdRuntime(import.meta.url);

const [champion,referencePath,candidatePath]=process.argv.slice(2);
if(!champion||!referencePath||!candidatePath||!path.isAbsolute(referencePath)||!path.isAbsolute(candidatePath)){
  throw new Error('Usage: node scripts/compare-skin-packages.mjs <champion> <absolute-reference.fantome> <absolute-candidate.fantome>');
}
if(!/^[a-z0-9]+$/i.test(champion))throw new Error('Champion must be an alphanumeric champion alias.');

const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
const normalized=name=>name.replaceAll('\\','/').toLowerCase();
const hashPath=name=>xxh64(name.toLowerCase()).toString(16).padStart(16,'0');
const BIN=`data/characters/${champion.toLowerCase()}/skins/skin0.bin`;
const HEADER=272,ENTRY=32,MAX_UNPACKED=1024*1024*1024;

function decodeWadMember(raw,kind,size){
  if(size>128*1024*1024)return null;
  if(kind===0)return raw;
  if(kind===1)return zlib.gunzipSync(raw,{maxOutputLength:size});
  if((kind===3||kind===4)&&zlib.zstdDecompressSync)return zlib.zstdDecompressSync(raw,{maxOutputLength:size});
  return null;
}

function wadSummary(bytes,alias){
  if(bytes.length<HEADER||bytes.toString('latin1',0,2)!=='RW'||bytes[2]!==3)throw new Error('Unsupported champion WAD.');
  const count=bytes.readUInt32LE(268),tableEnd=HEADER+count*ENTRY;
  if(count>65535||tableEnd>bytes.length)throw new Error('Invalid WAD entry table.');
  let totalUnpacked=0;
  const entries=new Map();
  for(let index=0;index<count;index++){
    const at=HEADER+index*ENTRY,key=bytes.readBigUInt64LE(at).toString(16).padStart(16,'0');
    const offset=bytes.readUInt32LE(at+8),compressedSize=bytes.readUInt32LE(at+12),size=bytes.readUInt32LE(at+16),flags=bytes.subarray(at+20,at+ENTRY);
    const kind=flags[0]&15;
    if(offset<tableEnd||offset+compressedSize>bytes.length)throw new Error(`Invalid WAD data range for ${key}.`);
    totalUnpacked+=size;if(totalUnpacked>MAX_UNPACKED)throw new Error('WAD expands beyond the 1 GiB analysis limit.');
    const raw=bytes.subarray(offset,offset+compressedSize),decoded=decodeWadMember(raw,kind,size);
    if(decoded&&decoded.length!==size)throw new Error(`WAD member ${key} has an unexpected decoded size.`);
    entries.set(key,{key,compressedSize,size,kind,flags:flags.toString('hex'),rawSha256:sha256(raw),sha256:decoded?sha256(decoded):null,decoded});
  }
  const skin0=entries.get(hashPath(BIN));
  const parsed=skin0?.decoded&&parseBin(skin0.decoded);
  const objects=(parsed?.objects||[]).map(object=>({
    key:`${object.type.toString(16).padStart(8,'0')}:${object.hash.toString(16).padStart(8,'0')}`,
    size:object.body.length,sha256:sha256(object.body),
  }));
  return {
    bytes:bytes.length,sha256:sha256(bytes),major:bytes[2],minor:bytes[3],count,
    headerSha256:sha256(bytes.subarray(0,HEADER)),entries,
    skin0:skin0?{
      path:BIN,key:hashPath(BIN),size:skin0.size,sha256:skin0.sha256,
      compression:skin0.kind,championSkinName:baseSkinName(skin0.decoded,alias),
      dependencies:parsed?.dependencies||[],objectCount:objects.length,objects,
    }:null,
  };
}

async function packageSummary(file,alias){
  const bytes=await readFile(file),files=await archiveFiles(file),byName=new Map(files.map(row=>[normalized(row.name),row.bytes]));
  const metadataBytes=byName.get('meta/info.json');
  if(!metadataBytes)throw new Error(`${file}: META/info.json is missing.`);
  const metadata=JSON.parse(metadataBytes.toString('utf8').replace(/^\uFEFF/,''));
  const wadName=`wad/${alias.toLowerCase()}.wad.client`,wadBytes=byName.get(wadName);
  if(!wadBytes)throw new Error(`${file}: ${wadName} is missing; loose-file WAD packages are not supported by this comparison yet.`);
  const entries=files.map(row=>({name:row.name,size:row.bytes.length,sha256:sha256(row.bytes)})).sort((a,b)=>a.name.localeCompare(b.name));
  return {file,size:bytes.length,sha256:sha256(bytes),metadata,entries,wad:wadSummary(wadBytes,alias)};
}

function diffObjects(left,right){
  const a=new Map(left?.objects?.map(row=>[row.key,row])||[]),b=new Map(right?.objects?.map(row=>[row.key,row])||[]),keys=new Set([...a.keys(),...b.keys()]);
  const rows=[];
  for(const key of [...keys].sort()){
    const before=a.get(key),after=b.get(key);
    if(!before)rows.push({key,status:'candidate-only',candidate:after});
    else if(!after)rows.push({key,status:'reference-only',reference:before});
    else if(before.sha256!==after.sha256||before.size!==after.size)rows.push({key,status:'changed',reference:before,candidate:after});
  }
  return rows;
}

function diffWad(left,right){
  const keys=new Set([...left.entries.keys(),...right.entries.keys()]),changes=[];
  let identical=0,sameContentDifferentEncoding=0;
  for(const key of [...keys].sort()){
    const before=left.entries.get(key),after=right.entries.get(key);
    if(!before){changes.push({key,status:'candidate-only',candidate:describe(after)});continue;}
    if(!after){changes.push({key,status:'reference-only',reference:describe(before)});continue;}
    if(before.sha256&&before.sha256===after.sha256){
      if(before.rawSha256===after.rawSha256&&before.flags===after.flags&&before.compressedSize===after.compressedSize)identical++;
      else{sameContentDifferentEncoding++;changes.push({key,status:'same-content-different-encoding',reference:describe(before),candidate:describe(after)});}
    }else changes.push({key,status:'changed-content',reference:describe(before),candidate:describe(after)});
  }
  return {referenceEntries:left.count,candidateEntries:right.count,identical,sameContentDifferentEncoding,changes};
}
function describe(row){return {compressedSize:row.compressedSize,size:row.size,compression:row.kind,flags:row.flags,rawSha256:row.rawSha256,decodedSha256:row.sha256};}

const reference=await packageSummary(referencePath,champion),candidate=await packageSummary(candidatePath,champion);
const wad=diffWad(reference.wad,candidate.wad),skinObjects=diffObjects(reference.wad.skin0,candidate.wad.skin0);
const report={
  champion,
  reference:{file:reference.file,size:reference.size,sha256:reference.sha256,metadata:reference.metadata,zipEntries:reference.entries,wad:{size:reference.wad.bytes,sha256:reference.wad.sha256,major:reference.wad.major,minor:reference.wad.minor,count:reference.wad.count,headerSha256:reference.wad.headerSha256,skin0:reference.wad.skin0&&{...reference.wad.skin0,objects:undefined}}},
  candidate:{file:candidate.file,size:candidate.size,sha256:candidate.sha256,metadata:candidate.metadata,zipEntries:candidate.entries,wad:{size:candidate.wad.bytes,sha256:candidate.wad.sha256,major:candidate.wad.major,minor:candidate.wad.minor,count:candidate.wad.count,headerSha256:candidate.wad.headerSha256,skin0:candidate.wad.skin0&&{...candidate.wad.skin0,objects:undefined}}},
  differences:{metadataEqual:JSON.stringify(reference.metadata)===JSON.stringify(candidate.metadata),zipEntryNamesEqual:reference.entries.map(row=>normalized(row.name)).join('\n')===candidate.entries.map(row=>normalized(row.name)).join('\n'),wadHeaderEqual:reference.wad.headerSha256===candidate.wad.headerSha256,wad,skin0Objects:skinObjects},
};
process.stdout.write(`${JSON.stringify(report,null,2)}\n`);
