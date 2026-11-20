import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import {copyFile,mkdir,readFile,readdir,rename,rm,stat,unlink,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {leagueFolder} from '../src/league-client.mjs';
import {convertRiotDatabaseSkin,RIOT_DATABASE_CONVERTER_REVISION} from '../src/riot-skin-converter.mjs';
import {readWadFileOnDisk} from '../src/skin-slots.mjs';
import databaseLocation from '../src/database-location.cjs';
import {ensureZstdRuntime} from './lib/runtime.mjs';

ensureZstdRuntime(import.meta.url);
const script=fileURLToPath(import.meta.url),root=path.resolve(path.dirname(script),'..');

const usage=`Usage: node scripts/convert-phantom-export.mjs [<export folder or phantom-latest.json>]
  [--export=<folder|phantom-latest.json|index.json>] [--output=<folder>] [--backup=<folder>]
  [--league=<folder>] [--only=<champion>] [--force] [--replace]
  [--phantom[=<exe>]] [--phantom-out=<folder>] [--offline] [--cleanup]`;
const args=process.argv.slice(2),options={force:false,replace:false,cleanup:false,offline:false,only:''};
for(const arg of args){
  if(arg==='--help'){console.log(usage);process.exit(0);}
  else if(arg==='--force')options.force=true;
  else if(arg==='--replace')options.replace=true;
  else if(arg==='--cleanup')options.cleanup=true;
  else if(arg==='--offline')options.offline=true;
  else if(arg.startsWith('--phantom='))options.phantom=arg.slice(10);
  else if(arg==='--phantom')options.phantom=true;
  else if(/^--(export|output|backup|league|only|phantom-out)=/.test(arg)){
    const [key,value]=arg.slice(2).split('=',2);
    options[key==='phantom-out'?'phantomOut':key]=value;
  }else if(!arg.startsWith('--')&&!options.export)options.export=arg;
  else throw new Error(`Unknown option: ${arg}\n${usage}`);
}

const local=process.env.LOCALAPPDATA||path.join(process.env.USERPROFILE||'','AppData','Local');const output=path.resolve(options.output||path.join(local,'friloverse-skins-data','Database','RiotSkins'));
if(!options.output)databaseLocation.migrateDatabase(local);
const backup=path.resolve(options.backup||path.join(local,'FrYiLoCo','Riot Skins Converted','Friloverse'));
if(output.toLowerCase()===backup.toLowerCase())throw new Error('The app database and its update-safe backup must use separate folders.');
const catalogue=JSON.parse(await readFile(path.join(root,'src','fryilo-catalog','champions.json'),'utf8'));
const aliasesByChampion=new Map(catalogue.champions.map(champion=>[String(champion.key),champion.id]));

/** The installed Phantom, or a path the caller named. */
async function phantomExecutable(value){
  if(typeof value==='string'){
    const exe=path.resolve(value);
    if(!await stat(exe).then(info=>info.isFile(),()=>false))throw new Error(`Phantom was not found at ${exe}.`);
    return exe;
  }
  const candidates=[
    path.join(local,'Programs','FrYiLo Phantom','fryilo-phantom.exe'),
  ];
  for(const exe of candidates)if(await stat(exe).then(info=>info.isFile(),()=>false))return exe;
  throw new Error('FrYiLo Phantom was not found. Install it, or pass --phantom=<path to fryilo-phantom.exe>.');
}

/** Runs Phantom's own command line and returns the export root it wrote. */
async function runPhantom(exe,outFolder){
  await mkdir(outFolder,{recursive:true});
  const league=path.resolve(options.league||await leagueFolder());
  const only=options.only.split(',').map(value=>value.trim()).filter(Boolean)
    .map(value=>aliasesByChampion.get(value)||value).join(',');
  const argv=['--league',league,'--out',outFolder];
  if(only)argv.push('--only',only);
  if(options.offline)argv.push('--offline');
  console.log(`Phantom: ${exe}`);
  console.log(`League:  ${league}`);
  console.log(`Output:  ${outFolder}${only?` (only ${only})`:''}`);
  const code=await new Promise((resolve,reject)=>{
    const child=spawn(exe,argv,{cwd:path.dirname(exe),stdio:'inherit',windowsHide:false});
    child.once('error',reject);
    child.once('exit',resolve);
  });
  if(code!==0)throw new Error(`Phantom stopped with exit code ${code}. If its message says "hashtable sync", pass --offline (or run Phantom once from its window).`);
  return outFolder;
}

/** A snapshot folder, from a snapshot, an export root, or phantom-latest.json. */
async function resolveSnapshot(value){
  const target=path.resolve(value);
  const info=await stat(target).catch(()=>null);
  if(!info)throw new Error(`The Phantom export was not found: ${target}`);
  if(info.isFile()){
    const name=path.basename(target).toLowerCase();
    if(name==='index.json')return path.dirname(target);
    if(name!=='phantom-latest.json')throw new Error('Pass a Phantom snapshot folder, its index.json, or phantom-latest.json.');
    const latest=JSON.parse(await readFile(target,'utf8'));
    if(typeof latest?.snapshot!=='string'||!latest.snapshot)throw new Error('phantom-latest.json has no snapshot name.');
    if(latest.snapshot!==path.basename(latest.snapshot)||latest.snapshot==='.'||latest.snapshot==='..')throw new Error('phantom-latest.json has an invalid snapshot name.');
    return path.join(path.dirname(target),latest.snapshot);
  }
  const latestFile=path.join(target,'phantom-latest.json');
  if(existsSync(latestFile)){
    try{
      const latest=JSON.parse(await readFile(latestFile,'utf8'));
      if(typeof latest?.snapshot==='string'&&latest.snapshot&&latest.snapshot===path.basename(latest.snapshot)&&latest.snapshot!=='.'&&latest.snapshot!=='..'){
        const snapshot=path.join(target,latest.snapshot);
        if(existsSync(path.join(snapshot,'index.json')))return snapshot;
      }
    }catch{/* Fall back to the newest complete snapshot. */}
  }
  if(existsSync(path.join(target,'index.json')))return target;
  const dirs=(await readdir(target,{withFileTypes:true})).filter(entry=>entry.isDirectory()).map(entry=>entry.name).sort().reverse();
  for(const name of dirs){
    const snapshot=path.join(target,name);
    if(existsSync(path.join(snapshot,'index.json')))return snapshot;
  }
  throw new Error('No Phantom snapshot (index.json and skins/) was found in that folder.');
}

const only=new Set(options.only.split(',').map(value=>value.trim().toLowerCase()).filter(Boolean));
if(options.phantom&&options.export)throw new Error('Pass either --phantom (to export first) or --export (an existing snapshot), not both.');
if(!options.phantom&&!options.export)throw new Error(`A Phantom snapshot is required.\n${usage}`);
const sourceRoot=options.phantom?await resolveSnapshot(await runPhantom(await phantomExecutable(options.phantom),path.resolve(options.phantomOut||path.join(local,'friloverse-skins','Phantom')))):await resolveSnapshot(options.export);
const skinsRoot=path.join(sourceRoot,'skins');
if(!await stat(skinsRoot).then(info=>info.isDirectory(),()=>false))throw new Error(`The snapshot has no skins folder: ${sourceRoot}`);
const index=JSON.parse(await readFile(path.join(sourceRoot,'index.json'),'utf8'));
if(!Array.isArray(index?.packages))throw new Error('The snapshot index is damaged.');
const packages=new Map();
for(const entry of index.packages){
  if(!entry||typeof entry.relative!=='string'||entry.status!=='accepted')continue;
  packages.set(entry.relative.replaceAll('\\','/'),entry);
}
console.log(`Snapshot: ${sourceRoot}`);
console.log(`League:   ${index.gameBuild||'unknown'} · ${packages.size} accepted package${packages.size===1?'':'s'}`);

const walk=async folder=>{
  const found=[];
  for(const entry of await readdir(folder,{withFileTypes:true})){
    const full=path.join(folder,entry.name);
    if(entry.isDirectory())found.push(...await walk(full));
    else if(entry.isFile()&&entry.name.toLowerCase().endsWith('.fantome'))found.push(full);
  }
  return found;
};
const files=(await walk(skinsRoot)).sort((a,b)=>a.localeCompare(b)).filter(file=>{
  if(!only.size)return true;
  const relative=path.relative(skinsRoot,file).split(path.sep),championId=relative[0];
  const entry=packages.get(relative.join('/'));
  return only.has(String(championId).toLowerCase())||only.has(String(entry?.champion||'').toLowerCase())||only.has(String(entry?.champion_id??championId));
});
if(!files.length)throw new Error(`No .fantome files were found${only.size?` for ${[...only].join(', ')}`:''} in ${skinsRoot}.`);

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
  }catch{/* A first conversion, or a damaged list that is replaced below. */}
}
await mkdir(output,{recursive:true});
const league=path.resolve(options.league||await leagueFolder());
const baseBins=new Map(),failures=[],failureCounts=new Map();
let converted=0,reused=0,failed=0;
for(const [position,file] of files.entries()){
  const relative=path.relative(skinsRoot,file).split(path.sep),relativePath=relative.join('/');
  const championId=relative[0],entry=packages.get(relativePath)||{};
  const champion=entry.champion||aliasesByChampion.get(championId);
  const skinId=String(entry.id??path.basename(file,'.fantome'));
  if(!champion||!/^[a-z0-9]+$/i.test(String(champion))){failed++;failures.push(`${relativePath}: champion ${championId} is not in Friloverse’s catalogue.`);continue;}
  try{
    if(!baseBins.has(champion))baseBins.set(champion,await readWadFileOnDisk(
      path.join(league,'Game','DATA','FINAL','Champions',`${champion}.wad.client`),
      `data/characters/${String(champion).toLowerCase()}/skins/skin0.bin`,
    ));
    const baseSkinBin=baseBins.get(champion);
    if(!baseSkinBin)throw new Error(`League's base-skin data for ${champion} could not be read.`);
    const result=await convertRiotDatabaseSkin({
      file,champion,skinId,league,outputDir:output,relativeOutput:path.join(...relative),force:options.force,baseSkinBin,
    });
    if(result.reused)reused++;else converted++;
    const prior=existing.get(relativePath);
    existing.set(relativePath,{
      id:Number(skinId),champion:Number(championId),parent:Number.isSafeInteger(entry.parent)?entry.parent:(relative.length>=4?Number(relative.at(-3)):null),
      relative:result.relative.split(path.sep).join('/'),path:`skins/${result.relative.split(path.sep).join('/')}`,
      sha:result.sha,size:result.size,name:String(entry.name||prior?.name||''),
    });
  }catch(error){
    failed++;
    const message=String(error.message).slice(0,240);
    failureCounts.set(message,(failureCounts.get(message)||0)+1);
    if(failures.length<250)failures.push(`${relativePath}: ${message}`);
  }
  if((position+1)%100===0||position+1===files.length)console.log(`[${position+1}/${files.length}] ${champion} ${skinId}: ${failed?`${failed} failed so far`:'converted'}`);
}

const rows=[...existing.values()].sort((a,b)=>Number(a.champion)-Number(b.champion)||Number(a.id)-Number(b.id)||String(a.relative).localeCompare(String(b.relative)));
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
await mkdir(backup,{recursive:true});
for(const row of rows){
  const relativeParts=String(row.relative).split('/'),source=path.join(output,...relativeParts),destination=path.join(backup,...relativeParts);
  try{
    if(!await stat(source).then(info=>info.isFile(),()=>false))continue;
    await mkdir(path.dirname(destination),{recursive:true});
    await copyFile(source,destination);
  }catch(error){console.log(`Backup skipped for ${row.relative}: ${error.message}`);}
}
await copyFile(manifestFile,path.join(backup,'riot-skins-manifest.json'));
console.log(`Converted ${converted}; already cached ${reused}; unsupported or failed ${failed}; total ${files.length}.`);
console.log(`Snapshot: ${sourceRoot}`);
console.log(`Output:   ${output}`);
console.log(`Backup:   ${backup}`);
console.log(`Manifest: ${rows.length} skins${existing.size&&!options.replace?` (${Math.max(0,rows.length-(converted+reused))} kept from the previous list)`:''}.`);
if(failures.length)console.log(`First ${failures.length} failures:\n  ${failures.join('\n  ')}`);
if(failureCounts.size)console.log(`Failure reasons:\n  ${[...failureCounts].sort((a,b)=>b[1]-a[1]).slice(0,15).map(([reason,count])=>`${count} × ${reason}`).join('\n  ')}`);
if(options.cleanup&&options.phantom){
  const resolvedSource=path.resolve(sourceRoot),resolvedOut=path.resolve(options.phantomOut||path.join(local,'friloverse-skins','Phantom'));
  const inside=resolvedSource.toLowerCase().startsWith((resolvedOut+path.sep).toLowerCase());
  if(inside){
    await rm(resolvedSource,{recursive:true,force:true});
    // Do not leave phantom-latest.json pointing at the snapshot just removed.
    const pointer=path.join(resolvedOut,'phantom-latest.json');
    try{
      const latest=JSON.parse(await readFile(pointer,'utf8'));
      if(latest?.snapshot===path.basename(resolvedSource))await unlink(pointer);
    }catch{/* No pointer, or it names another snapshot. */}
    console.log(`Removed the converted snapshot: ${resolvedSource}`);
  }else console.log(`Snapshot kept outside the Phantom output folder: ${resolvedSource}`);
}
if(failed)process.exitCode=1;
