// A custom skin with no prepared copy, on the real LTK Manager and the real engine, outside a match:
// made on the pick and kept, then picked again from what was kept, then as an old copy after an
// "update".
// Everything is in a temporary folder and the library is compared afterwards. Patches nothing.
// Refuses during a draft or game, or if LTK is open. Run with the bundled Node 24 (zstd).
import {mkdtemp,readFile,readdir,rm,stat,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {LtkBridge} from '../src/ltk.mjs';
import {SkinEngine} from '../src/engine.mjs';
import {PreparedSkinLibrary} from '../src/prepared-skins.mjs';
import {buildSlotMod} from '../src/skin-slots.mjs';
import {assertMachineIdle,ensureZstdRuntime} from './lib/runtime.mjs';

ensureZstdRuntime(import.meta.url);
await assertMachineIdle();

const root=path.join(process.env.LOCALAPPDATA,'friloverse-skins-data','Database','Custom Skins');
const champions=JSON.parse(await readFile(new URL('../src/ui/champions.json',import.meta.url),'utf8'));
const library=[];
for(const folder of await readdir(root,{withFileTypes:true}))if(folder.isDirectory()){
  const row=champions.find(item=>item.id.toLowerCase()===folder.name.toLowerCase()||item.name.toLowerCase()===folder.name.toLowerCase());
  if(row)for(const name of await readdir(path.join(root,folder.name)))if(name.toLowerCase().endsWith('.fantome')){
    const file=path.join(root,folder.name,name);library.push({file,alias:row.id,label:name.slice(0,-8),size:(await stat(file)).size});
  }
}
library.sort((a,b)=>a.size-b.size);
if(library.length<3){console.error('Needs at least 3 custom skins.');process.exit(2);}
const samples=[library[0],library[library.length>>1],library.at(-1)];
for(const pick of samples){
  const bytes=await readFile(pick.file);
  pick.key=createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

const dataDir=await mkdtemp(path.join(tmpdir(),'friloverse-on-pick-'));
let noSlot=false;
const prepared=new PreparedSkinLibrary({dataDir});
const bridge=new LtkBridge();
const engine=new SkinEngine({bridge,dataDir,settle:0,
  buildSlot:options=>buildSlotMod(options).catch(error=>{console.log('  no slot copy:',error.message);throw error;}),
  // Five custom skins have no skin0.bin to copy (see Findings); the base skin is the way then.
  onSlotFailed:alias=>{noSlot=true;console.log(`  no slot copy of ${alias}; League's base skin is the way then`);},
  prepareFile:pick=>prepared.resolve(pick),
  keepPrepared:async(pick,modId)=>prepared.keep(pick,(await bridge.mods()).find(mod=>mod.id===modId)),
  onRetry:message=>console.log('  engine:',message)});
const pause=ms=>new Promise(done=>setTimeout(done,ms));
const settle=async()=>{await pause(50);for(let i=0;i<1200&&!engine.settled;i++)await pause(50);};
const shape=mods=>JSON.stringify(mods.map(mod=>[mod.id,!!mod.enabled]).sort());
const manifestFile=path.join(dataDir,'prepared-skins','manifest.json');
const manifest=async()=>JSON.parse(await readFile(manifestFile,'utf8'));
const fail=message=>{process.exitCode=1;console.log('  FAILED:',message);};
const mb=bytes=>(bytes/2**20).toFixed(1);

// One whole draft: LTK Manager warm, the pick, and everything undone afterwards.
const draft=async(pick,word)=>{
  engine.setHold({open:true,frozen:false,sealed:false});engine.setSlots(new Map([[pick.alias.toLowerCase(),1]]));
  engine.observe('ChampSelect');await settle();
  noSlot=false;
  const started=Date.now();
  engine.setPersonal(pick);await settle();
  const ms=Date.now()-started,failure=engine.failureFor(pick.key),rows=engine.journal.staged.length;
  console.log(`  ${word}: ${ms} ms, ${rows} in LTK${failure?`, told: ${failure}`:''}`);
  if(!failure&&rows!==(noSlot?1:2))fail(`${rows} in LTK Manager`);
  engine.setPersonal(null);engine.setSlots(new Map());engine.setHold({open:false,frozen:false,sealed:false});engine.observe('Lobby');
  await pause(100);
  for(let i=0;i<600&&(engine.busy||engine.waiting||bridge.connected);i++)await pause(50);
  await pause(800);
  return {ms,failure};
};

let before;
try{
  await bridge.ensure();before=shape(await bridge.mods());await bridge.quit();await pause(800);
  for(const pick of samples){
    console.log(`${pick.label} (${pick.alias}, ${mb(pick.size)} MB)`);
    const first=await draft(pick,'First pick, no copy');
    if(first.failure){console.log('  LTK refused it, which is its own answer. Nothing kept.');continue;}
    const entry=(await manifest()).entries[pick.key];
    if(entry?.status!=='ready')fail('the repaired copy was not kept');
    else if(!(await prepared.resolve(pick)).prepared)fail('the kept copy should count as prepared');
    const second=await draft(pick,'Next match, from what was kept');
    if(second.failure)fail(second.failure);
    // What a League patch does: every copy becomes an old one, for LTK to check.
    const old=await manifest();old.gameFingerprint='an older League';await writeFile(manifestFile,JSON.stringify(old));
    const stale=await prepared.resolve(pick);
    if(stale.prepared!==false||stale.working)fail('an old copy should be used, for LTK to check');
    const third=await draft(pick,'After a patch, from the old copy');
    if(third.failure)fail(third.failure);
    if(!(await prepared.resolve(pick)).prepared)fail('an old copy LTK accepted should be current again');
  }
  await bridge.ensure();
  const after=shape(await bridge.mods());
  await bridge.quit();await pause(800);
  if(after!==before)fail('THE LIBRARY DIFFERS.');else console.log('The library is back as it was.');
}finally{
  clearTimeout(engine.timer);clearTimeout(engine.armTimer);
  await engine.shutdown().catch(()=>{});
  await bridge.quit().catch(()=>{});
  await rm(dataDir,{recursive:true,force:true}).catch(()=>{});
}
console.log(process.exitCode?'FAILED.':'Passed.');
