import {createHash,randomBytes} from 'node:crypto';
import {mkdir,readFile,rename,stat,unlink,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {archiveFiles,replaceWadFile,sourceHash} from './custom-skin-compat.mjs';
import {readWadFile,readWadFileOnDisk,writeZip} from './skin-slots.mjs';
import {baseSkinName,bodyMeshPaths,meshPairs,renameAudioNames,renameBaseSkin,useBaseSkinMesh} from './bin-compat.mjs';

export const RIOT_DATABASE_CONVERTER_REVISION=7;
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const gitBlobSha=bytes=>createHash('sha1').update(Buffer.concat([Buffer.from('blob '+bytes.length),Buffer.from([0]),bytes])).digest('hex');
const normalized=value=>value.replaceAll('\\','/').toLowerCase();

/** Convert one FrYiLoCo generated Riot skin archive into a separate LTK-compatible copy. */
export async function convertRiotDatabaseSkin({file,champion,skinId,league,outputDir,relativeOutput,force=false,baseSkinBin}){
  const alias=String(champion||'').toLowerCase();
  if(!/^[a-z0-9]+$/.test(alias))throw new Error('Champion must be an alphanumeric League alias.');
  if(!path.isAbsolute(file)||!path.isAbsolute(league)||!path.isAbsolute(outputDir))throw new Error('Input, League and output paths must be absolute.');
  const id=String(skinId||path.basename(file,'.fantome'));
  const outputParts=String(relativeOutput||path.join(alias,id,`${id}.fantome`)).split(path.sep);
  if(outputParts.some(part=>!part||part==='.'||part==='..')||!outputParts.at(-1).toLowerCase().endsWith('.fantome'))throw new Error('Output path must be a relative .fantome path inside the database folder.');
  const outputRoot=path.resolve(outputDir),output=path.resolve(outputRoot,...outputParts),outputRelative=path.relative(outputRoot,output);
  if(!outputRelative||outputRelative.startsWith('..')||path.isAbsolute(outputRelative))throw new Error('Output path must stay inside the database folder.');
  const sourceSha=await sourceHash(file),files=await archiveFiles(file);
  const wadName=`wad/${alias}.wad.client`,wad=files.find(row=>normalized(row.name)===wadName);
  if(!wad)throw new Error(`The archive has no ${wadName}.`);
  const base=baseSkinBin||await readWadFileOnDisk(
    path.join(league,'Game','DATA','FINAL','Champions',`${alias}.wad.client`),
    `data/characters/${alias}/skins/skin0.bin`,
  );
  if(!base)throw new Error(`League's base-skin data for ${champion} could not be read.`);
  const baseName=baseSkinName(base,alias);
  if(!baseName)throw new Error(`League's base-skin name for ${champion} could not be read.`);
  const inside=`data/characters/${alias}/skins/skin0.bin`,source=readWadFile(wad.bytes,inside);
  if(!source)throw new Error(`The archive has no readable ${inside}.`);
  const sourceName=baseSkinName(source,alias);
  if(!sourceName)throw new Error(`The archive has no readable ${champion} base-skin object.`);
  // A chroma's extra particle models have no base counterpart and may stay where the
  // game already ships them; every body model directly under the skin folder must move.
  const pairs=meshPairs(source,base,alias,{lenient:true});
  const mapped=new Set((pairs||[]).map(([from])=>from.toLowerCase()));
  if(!pairs||bodyMeshPaths(source,alias).some(model=>!mapped.has(model.toLowerCase())))throw new Error(`${sourceName} does not have one supported source mesh pair to retarget.`);
  const rebased=useBaseSkinMesh(source,alias,base,{lenient:true});
  if(!rebased)throw new Error(`${sourceName} does not have one supported source mesh pair to retarget.`);
  const audioRenamed=renameAudioNames(rebased,alias);
  const normalizedBin=renameBaseSkin(audioRenamed,alias,baseName)||audioRenamed;
  if(baseSkinName(normalizedBin,alias)!==baseName)throw new Error('The converted skin did not resolve to League’s base-skin name.');
  wad.bytes=replaceWadFile(wad.bytes,inside,normalizedBin);
  const baseSha=hash(base);
  if(!/^\d{1,7}$/.test(id))throw new Error('Skin ID must be numeric.');
  const converted=writeZip(files),sha=gitBlobSha(converted);
  if(!force)try{if((await stat(output)).isFile()&&(await readFile(output)).equals(converted))return {file:output,relative:outputParts.join(path.sep),sourceHash:sourceSha,baseHash:baseSha,sourceName,baseName,sha,size:converted.length,reused:true};}catch{/* Create or replace the missing cache entry. */}
  await mkdir(path.dirname(output),{recursive:true});
  const temp=`${output}.${randomBytes(8).toString('hex')}.tmp`;
  try{
    await writeFile(temp,converted,{flag:'wx'});
    try{await rename(temp,output);}catch(error){
      if(error.code!=='EEXIST'&&error.code!=='EPERM')throw error;
      await unlink(output).catch(()=>{});
      await rename(temp,output);
    }
  }finally{await unlink(temp).catch(()=>{});}
  return {file:output,relative:outputParts.join(path.sep),sourceHash:sourceSha,baseHash:baseSha,sourceName,baseName,sha,size:converted.length,reused:false};
}

