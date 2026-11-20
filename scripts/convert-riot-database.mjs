import {existsSync} from 'node:fs';
import {copyFile,mkdir,readdir,readFile,rename,unlink,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {leagueFolder} from '../src/league-client.mjs';
import {convertRiotDatabaseSkin,RIOT_DATABASE_CONVERTER_REVISION} from '../src/riot-skin-converter.mjs';
import {SPECIAL_APPEARANCES} from '../src/fryilo-catalog/catalog.mjs';
import {readWadFileOnDisk} from '../src/skin-slots.mjs';
import databaseLocation from '../src/database-location.cjs';
import {ensureZstdRuntime} from './lib/runtime.mjs';

ensureZstdRuntime(import.meta.url);
const script=fileURLToPath(import.meta.url),root=path.resolve(path.dirname(script),'..');

const args=process.argv.slice(2),options={force:false,replace:false,limit:Infinity};
for(const arg of args){
  if(arg==='--force')options.force=true;
  else if(arg==='--replace')options.replace=true;
  else if(arg==='--help'){
    console.log('Usage: node scripts/convert-riot-database.mjs [--source=<folder>] [--output=<folder>] [--backup=<folder>] [--league=<folder>] [--champion-id=<id>] [--skin-id=<id>] [--limit=<count>] [--force] [--replace]');
    process.exit(0);
  }else if(/^--(source|output|backup|league|limit|champion-id|skin-id)=/.test(arg)){
    const [key,value]=arg.slice(2).split('=',2);
    if(key==='limit')options.limit=Number(value);
    else if(key==='champion-id')options.championId=value;
    else if(key==='skin-id')options.skinId=value;
    else options[key]=value;
  }else throw new Error(`Unknown option: ${arg}`);
}
if(!Number.isSafeInteger(options.limit)&&options.limit!==Infinity||options.limit<1)throw new Error('--limit must be a positive whole number.');
const local=process.env.LOCALAPPDATA||path.join(process.env.USERPROFILE||'','AppData','Local');
if(!options.output)databaseLocation.migrateDatabase(local);
const source=path.resolve(options.source||path.join(local,'FrYiLoCo','Riot Skins'));
const output=path.resolve(options.output||path.join(local,'friloverse-skins-data','Database','RiotSkins'));
const backup=path.resolve(options.backup||path.join(local,'FrYiLoCo','Riot Skins Converted','Friloverse'));
if(output.toLowerCase()===backup.toLowerCase())throw new Error('The app database and its update-safe backup must use separate folders.');
await mkdir(output,{recursive:true});
const league=path.resolve(options.league||await leagueFolder());
const catalogue=JSON.parse(await readFile(path.join(root,'src','fryilo-catalog','champions.json'),'utf8'));
const aliases=new Map(catalogue.champions.map(champion=>[String(champion.key),champion.id]));
const displayNames=new Map(catalogue.champions.map(champion=>[String(champion.key),new Map(champion.skins.map(skin=>[String(skin.id),skin.name]))]));
const walk=async(folder)=>{
  const found=[];
  for(const entry of await readdir(folder,{withFileTypes:true})){
    const full=path.join(folder,entry.name);
    if(entry.isDirectory())found.push(...await walk(full));
    else if(entry.isFile()&&entry.name.toLowerCase().endsWith('.fantome'))found.push(full);
  }
  return found;
};
const files=(await walk(source)).filter(file=>{
  const relative=path.relative(source,file).split(path.sep);
  return (!options.championId||relative[0]===options.championId)&&(!options.skinId||path.basename(file,'.fantome')===options.skinId);
}).sort((a,b)=>a.localeCompare(b)).slice(0,options.limit);
if(!files.length)throw new Error(`No .fantome files were found in ${source}.`);
// A conversion updates only its own rows and keeps the rest of the manifest,
// including a skin whose archive failed this time but was valid before. Before
// this, `--champion-id` or `--limit` rewrote the manifest with just those skins.
const manifestFile=path.join(output,'riot-skins-manifest.json');
const safeRelative=relative=>{
  const parts=String(relative||'').replaceAll('\\','/').split('/');
  return parts.length>=3&&parts.length<=8&&parts.every(part=>part&&part!=='.'&&part!=='..'&&!part.includes(':'))
    &&/^\d{1,6}$/.test(parts[0])&&parts.slice(1,-1).every(part=>/^\d{1,7}$/.test(part))
    &&parts.at(-1).endsWith('.fantome');
};
const existing=new Map();
if(!options.replace){
  try{
    const saved=JSON.parse(await readFile(manifestFile,'utf8'));
    for(const row of Array.isArray(saved?.skins)?saved.skins:[]){
      if(typeof row?.relative!=='string'||!/^[0-9a-f]{40}$/i.test(String(row.sha||''))||!safeRelative(row.relative)||!Number.isSafeInteger(row.id)||!Number.isSafeInteger(row.champion))continue;
      const relative=row.relative.replaceAll('\\','/');
      existing.set(relative,{...row,relative,path:`skins/${relative}`});
    }
  }catch{/* No previous manifest: this run creates one. */}
}
let converted=0,reused=0,failed=0;const errors=[],failureCounts=new Map(),manifestSkins=[];
const baseBins=new Map();
for(let index=0;index<files.length;index++){
  const file=files[index],relative=path.relative(source,file).split(path.sep),championId=relative[0],champion=aliases.get(championId),skinId=path.basename(file,'.fantome'),relativePath=relative.join('/');
  if(!champion){failed++;errors.push(`${path.relative(source,file)}: champion ${championId} is not in Friloverse’s catalogue.`);continue;}
  try{
    let base=baseBins.get(champion);
    if(!base){base=readWadFileOnDisk(path.join(league,'Game','DATA','FINAL','Champions',`${champion}.wad.client`),`data/characters/${champion.toLowerCase()}/skins/skin0.bin`);baseBins.set(champion,base);}
    const relativeOutput=path.relative(source,file);
    const result=await convertRiotDatabaseSkin({file,champion,skinId,league,outputDir:output,relativeOutput,force:options.force,baseSkinBin:await base});
    if(result.reused)reused++;else converted++;
    const row={
      id:Number(skinId),champion:Number(championId),parent:relative.length>=4?Number(relative.at(-3)):null,
      relative:result.relative.split(path.sep).join('/'),path:`skins/${result.relative.split(path.sep).join('/')}`,
      sha:result.sha,size:result.size,name:displayNames.get(championId)?.get(skinId)||SPECIAL_APPEARANCES.get(skinId)?.name||'',
    };
    manifestSkins.push(row);
    existing.set(relativePath,row);
    if((index+1)%100===0||index+1===files.length)console.log(`[${index+1}/${files.length}] ${champion} ${displayNames.get(championId)?.get(skinId)||skinId}: ${result.reused?'cached':'converted'}`);
  }catch(error){
    failed++;
    const message=String(error.message).slice(0,240),reason=message.includes('does not have one supported source mesh pair')?'does not have one supported source mesh pair to retarget':message;
    failureCounts.set(reason,(failureCounts.get(reason)||0)+1);
    if(errors.length<250)errors.push(`${path.relative(source,file)}: ${message}`);
  }
}
const rows=options.replace?manifestSkins:[...existing.values()].sort((a,b)=>Number(a.champion)-Number(b.champion)||Number(a.id)-Number(b.id)||String(a.relative).localeCompare(String(b.relative)));
const manifest={version:1,converterRevision:RIOT_DATABASE_CONVERTER_REVISION,generatedAt:new Date().toISOString(),skins:rows};
const manifestTemp=`${manifestFile}.${process.pid}.tmp`;
try{
  await writeFile(manifestTemp,JSON.stringify(manifest),{flag:'wx'});
  try{await rename(manifestTemp,manifestFile);}catch(error){
    if(error.code!=='EEXIST'&&error.code!=='EPERM')throw error;
    await unlink(manifestFile).catch(()=>{});
    await rename(manifestTemp,manifestFile);
  }
}
finally{await unlink(manifestTemp).catch(()=>{});}
const convertedRows=new Set(manifestSkins.map(skin=>skin.relative));
for(const skin of rows){
  const relativeParts=skin.relative.split('/'),sourceFile=path.join(output,...relativeParts),destination=path.join(backup,...relativeParts);
  if(!convertedRows.has(skin.relative)&&existsSync(destination))continue;
  if(!existsSync(sourceFile))continue;
  await mkdir(path.dirname(destination),{recursive:true});
  await copyFile(sourceFile,destination);
}
await mkdir(backup,{recursive:true});
await copyFile(manifestFile,path.join(backup,'riot-skins-manifest.json'));
console.log(`Source: ${source}`);
console.log(`Output: ${output}`);
console.log(`Update-safe backup: ${backup}`);
console.log(`Converted ${converted}; already cached ${reused}; unsupported or failed ${failed}; total ${files.length}.`);
if(!options.replace)console.log(`Manifest: ${rows.length} skins (${Math.max(0,rows.length-manifestSkins.length)} carried over from the previous list).`);
if(errors.length)console.log(`First ${errors.length} failures:\n  ${errors.join('\n  ')}`);
if(failureCounts.size)console.log(`Failure reasons:\n  ${[...failureCounts].sort((a,b)=>b[1]-a[1]).slice(0,15).map(([reason,count])=>`${count} × ${reason}`).join('\n  ')}`);
if(failed)process.exitCode=1;

