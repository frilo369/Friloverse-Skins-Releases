// Can a skin be put over the one selected in League? Offline: every custom and local skin and a sample
// of Riot's list are re-keyed for a real skin number, reading League's own files where needed.
// Then, on the real LTK Manager: a skin and its small mod are installed together, LTK's verdict
// on both is read, and the library is put back. No game is started, so `overlay verified` in
// LTK's log after a real match stays the proof. Refuses during a match or if LTK is open.
// Needs zstd: run with bundled Node 24, or Electron with ELECTRON_RUN_AS_NODE=1.
import {mkdtemp,readFile,readdir,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {buildSlotMod,readWadFile} from '../src/skin-slots.mjs';
import {LtkBridge,ltkRunning} from '../src/ltk.mjs';
import {RiotCatalogue} from '../src/riot-skins-local.mjs';
import {SkinEngine} from '../src/engine.mjs';
import {championKey} from '../src/model.mjs';
import {assertMachineIdle,ensureZstdRuntime} from './lib/runtime.mjs';

ensureZstdRuntime(import.meta.url);
await assertMachineIdle({allowLtk:true});

const dir=await mkdtemp(path.join(tmpdir(),'friloverse-slots-'));
const slotDir=path.join(dir,'built');
const SLOT=1,RIOT_SAMPLE=[[103,'Ahri',103086],[11,'MasterYi',11116],[238,'Zed',238001],[1,'Annie',1001],[62,'MonkeyKing',62001],[266,'Aatrox',266008]];
const custom=path.join(process.env.LOCALAPPDATA,'friloverse-skins-data','Database','Custom Skins');
const local=path.join(process.env.LOCALAPPDATA,'friloverse-skins-data','Database','LocalSkins');
let failed=0;
const champions=JSON.parse(await readFile(new URL('../src/ui/champions.json',import.meta.url),'utf8'));
const aliasOf=name=>champions.find(row=>championKey(row.id)===championKey(name)||championKey(row.name)===championKey(name))?.id||name;
const moved=[];
try{
  let libraryBuilt=0;
  for(const [label,root] of [['Custom skins',custom],['Local skins',local]]){
    let total=0,built=0;
    const refused=[];
    for(const champion of await readdir(root,{withFileTypes:true}).catch(()=>[])){
      if(!champion.isDirectory())continue;
      for(const name of await readdir(path.join(root,champion.name)).catch(()=>[])){
        if(!/\.(fantome|zip)$/i.test(name))continue;
        total++;
        const file=path.join(root,champion.name,name);
        const alias=aliasOf(champion.name);
        const out=await buildSlotMod({file,champion:alias,slot:SLOT,dir:slotDir}).catch(error=>{refused.push(`${champion.name}/${name}: ${error.message}`);return false;});
        if(out){
          built++;
          const pick={key:`${label}-${name}`,file,alias,label:name,local:label==='Local skins'};
          if(name==='Big Smoke Nasus.fantome')moved.unshift(pick);
          else if(moved.length<12)moved.push(pick);
        }
        else if(out===null)refused.push(`${champion.name}/${name}: cannot be moved`);
      }
    }
    console.log(`${label}: ${built} of ${total} can be put over a selected skin.`);
    for(const row of refused)console.log(`  ${row}`);
    libraryBuilt+=built;
  }
  const catalogue=new RiotCatalogue();
  await catalogue.check();
  let riotBuilt=0,riotTotal=0;
  for(const [number,alias,skinId] of RIOT_SAMPLE){
    const known=(await catalogue.forChampion(number)).find(skin=>skin.id===skinId)||(await catalogue.forChampion(number))[0];
    if(!known)continue;
    riotTotal++;
    const ready=await catalogue.ensure(number,known.id);
    // Slot 86 of Ahri is a skin whose chromas link it, which is the hard case.
    const slot=number===103?86:SLOT;
    const out=await buildSlotMod({file:ready.file,champion:alias,slot,dir:slotDir}).catch(error=>{console.log(`  ${alias} ${known.id}: ${error.message}`);return null;});
    if(out){riotBuilt++;moved.unshift({key:ready.sha,file:ready.file,alias,label:`${alias} ${known.id}`,trusted:true,slot});}
    else console.log(`  ${alias} ${known.id}: cannot be moved`);
  }
  console.log(`Riot skins: ${riotBuilt} of ${riotTotal} sampled can be moved.`);
  if(libraryBuilt===0||riotBuilt===0)failed=1;

  if(await ltkRunning()){console.log('LTK Manager is open: skipped its part. Close it and run this again.');}
  else{
    const bridge=new LtkBridge();
    const pause=ms=>new Promise(done=>setTimeout(done,ms));
    const engine=new SkinEngine({bridge,dataDir:dir,settle:0,onSlotFailed:alias=>{failed=1;console.log(`LTK refused the copy for ${alias}.`);}});
    const settle=async()=>{await pause(100);for(let i=0;i<900&&engine.busy;i++)await pause(50);};
    const library=mods=>JSON.stringify(mods.map(mod=>[mod.id,!!mod.enabled]).sort());
    try{
      await bridge.ensure();
      const before=library(await bridge.mods());
      await bridge.quit();await pause(800);
      // Asset-only skins such as Big Smoke Nasus add no skin0.bin to the overlay.
      const inOverlay=async(pick,slot,since)=>{
        const low=pick.alias.toLowerCase();
        const file=path.join(process.env.APPDATA,'dev.leaguetoolkit.manager','profiles','default','overlay','DATA','FINAL','Champions',`${pick.alias}.wad.client`);
        for(let i=0;i<60;i++){
          const fresh=await stat(file).then(row=>row.mtimeMs>=since,()=>false);
          if(fresh){
            const wad=await readFile(file).catch(()=>null);
            try{
              if(wad&&readWadFile(wad,`data/characters/${low}/skins/skin${slot}.bin`))return true;
            }catch{/* LTK is still writing it. */}
          }
          await pause(500);
        }
        return false;
      };
      let tried={riot:0,custom:0};
      for(const pick of moved){
        const kind=pick.trusted?'riot':'custom';
        if(tried[kind]>=2)continue;
        const slot=pick.slot||SLOT,since=Date.now()-2000;
        engine.setHold({open:false,frozen:false,sealed:true});engine.observe('ChampSelect');
        engine.setSlots(new Map([[pick.alias.toLowerCase(),slot]]));
        engine.setPersonal(pick);
        await settle();
        const staged=engine.journal.staged.length;
        console.log(`${pick.label} at slot ${slot}: status ${engine.status}, ${staged} mods staged${engine.error?`, ${engine.error}`:''}`);
        if(staged===0&&engine.status==='failed'&&!pick.trusted)console.log('  LTK refuses this skin itself, so it got no copy, as it should.');
        else if(staged!==2)failed=1;
        else{
          tried[kind]++;
          const built=await inOverlay(pick,slot,since)&&!(await bridge.overlayMissing([pick.alias],new Map([[pick.alias,slot]]))).length;
          console.log(`  LTK built skin${slot} into its overlay: ${built}`);
          if(!built)failed=1;
        }
        engine.setPersonal(null);
        await settle();
      }
      if(!tried.riot||!tried.custom){failed=1;console.log('Did not reach a Riot and a custom skin.');}
      engine.observe('None');
      await settle();
      await pause(800);
      if(!await ltkRunning()){
        await bridge.ensure();
        const after=library(await bridge.mods());
        await bridge.quit();
        console.log(after===before?'Library restored.':`LIBRARY DIFFERS\n  before ${before}\n  after  ${after}`);
        if(after!==before)failed=1;
      }
    }finally{
      await engine.shutdown().catch(()=>{});
      await bridge.quit().catch(()=>{});
    }
  }
}finally{await rm(dir,{recursive:true,force:true}).catch(()=>{});}
console.log(failed?'FAILED':'OK');
process.exit(failed);
