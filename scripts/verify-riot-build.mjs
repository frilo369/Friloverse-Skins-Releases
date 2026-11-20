// Builds Riot skins from the installed League and asks the real LTK Manager whether it
// would load each one. It installs and removes temporary mods and restores the library.
// Refuses during a draft or game, or while LTK Manager is open.
//   node --experimental-... (needs zstd: use the bundled Node 24 or Electron as Node)
//   scripts/verify-riot-build.mjs [--count=24] [--skin=<id>] [--champion=<id>] [--from=<n>]
// --from=<n> skips the first n skins of the sample, to carry on after an interrupted run.
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {LtkBridge} from '../src/ltk.mjs';
import {RiotSkinBuilder} from '../src/riot-skin-builder.mjs';
import {RiotCatalogue} from '../src/riot-skins-local.mjs';
import {isFormSkin} from '../src/fryilo-catalog/catalog.mjs';
import {assertMachineIdle,ensureZstdRuntime} from './lib/runtime.mjs';

ensureZstdRuntime(import.meta.url);
await assertMachineIdle();

const count=Math.max(1,Number(process.argv.find(arg=>arg.startsWith('--count='))?.slice(8))||24);
const from=Math.max(0,Number(process.argv.find(arg=>arg.startsWith('--from='))?.slice(7))||0);
const only=process.argv.find(arg=>arg.startsWith('--skin='))?.slice(7);
const champion=process.argv.find(arg=>arg.startsWith('--champion='))?.slice(11);
const cache=await mkdtemp(path.join(tmpdir(),'friloverse-riot-build-'));
const builder=new RiotSkinBuilder({cacheDir:cache});
const catalogue=new RiotCatalogue({buildSkin:(skin,options)=>builder.build(skin,options)});
await catalogue.load();
if(!catalogue.ready){console.error('The Riot skin list is empty; connect once or run the converter.');process.exit(2);}
const matching=champion?catalogue.skins().filter(skin=>String(skin.champion)===champion):catalogue.skins();
const skins=only?matching.filter(skin=>String(skin.id)===only):matching;
if(!skins.length){console.error('No matching skin in the list.');process.exit(2);}
const sample=[];const step=Math.max(1,Math.floor(skins.length/count));
for(let index=0;index<skins.length&&sample.length<count;index+=step)sample.push(skins[index]);

const bridge=new LtkBridge();
const failures=[];
let healthy=0;
try{
  await bridge.ensure();
  const before=JSON.stringify((await bridge.mods()).map(mod=>[mod.id,!!mod.enabled]).sort());
  for(const [index,skin] of sample.entries()){
    if(index<from)continue;
    let built;
    try{built=await catalogue.ensureSkin(skin);}
    catch(error){failures.push([skin.id,skin.name,'build',error.message]);console.log(`[${index+1}/${sample.length}] ${skin.champion}/${skin.id}: BUILD FAILED (${error.message})`);continue;}
    let mod;
    try{mod=await bridge.install(built.file);}
    catch(error){failures.push([skin.id,skin.name,'install',error.message]);console.log(`[${index+1}/${sample.length}] ${skin.champion}/${skin.id}: INSTALL FAILED (${error.message})`);continue;}
    if(mod.kind!=='installed'){failures.push([skin.id,skin.name,'install',JSON.stringify(mod)]);continue;}
    const verdict=await bridge.readyMod(mod.mod.id,{repair:isFormSkin(skin)});
    await bridge.uninstall(mod.mod.id);
    if(verdict){failures.push([skin.id,skin.name,verdict]);console.log(`[${index+1}/${sample.length}] ${skin.champion}/${skin.id}: ${verdict}`);}
    else healthy++;
    if((index+1)%250===0)console.log(`[${index+1}/${sample.length}] ${healthy} load, ${failures.length} failed so far`);
  }
  const after=JSON.stringify((await bridge.mods()).map(mod=>[mod.id,!!mod.enabled]).sort());
  console.log(`Health check: ${healthy} of ${sample.length} load${failures.length?`; ${failures.length} failed`:''}.`);
  if(before!==after){console.log('THE LTK LIBRARY DIFFERS:',before,'!=',after);process.exitCode=1;}
}finally{
  await bridge.quit();
  await rm(cache,{recursive:true,force:true});
}
if(failures.length)process.exitCode=1;
