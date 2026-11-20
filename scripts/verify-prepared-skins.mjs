// Real LTK staging of a prepared custom skin and its selected-slot copy, outside a game.
// Uses the prepared cache, restores the player's library, never launches League.
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {PreparedSkinLibrary} from '../src/prepared-skins.mjs';
import {LtkBridge} from '../src/ltk.mjs';
import {SkinEngine} from '../src/engine.mjs';
import {readWadFileOnDisk,parseBin,binHash} from '../src/skin-slots.mjs';
import {baseSkinName} from '../src/bin-compat.mjs';
import {assertMachineIdle,ensureZstdRuntime} from './lib/runtime.mjs';

ensureZstdRuntime(import.meta.url);
await assertMachineIdle();
const dataDir=path.join(process.env.APPDATA,'friloverse-skins');
const manifest=JSON.parse(await readFile(path.join(dataDir,'prepared-skins','manifest.json'),'utf8'));
const query=process.argv[2]||'Yumeko';
const [key,entry]=Object.entries(manifest.entries).find(([,row])=>row.status==='ready'&&row.label?.includes(query))||[];
if(!entry?.champion)throw new Error(`No prepared champion skin matches ${query}.`);
const library=new PreparedSkinLibrary({dataDir}),bridge=new LtkBridge();
const dir=await mkdtemp(path.join(tmpdir(),'friloverse-prepared-check-'));
const engine=new SkinEngine({bridge,dataDir:dir,settle:0,prepareFile:pick=>library.resolve(pick)});
const pause=ms=>new Promise(done=>setTimeout(done,ms));
const settle=async()=>{
  await pause(50);
  for(let i=0;i<1200&&(engine.busy||engine.waiting);i++)await pause(50);
  assert.equal(engine.busy,false,'Engine did not settle.');
};
const snapshot=mods=>JSON.stringify(mods.map(mod=>[mod.id,!!mod.enabled]).sort());
let before;
try{
  await bridge.ensure();before=snapshot(await bridge.mods());await bridge.quit();await bridge.closed();
  const begun=Date.now(),alias=entry.champion.toLowerCase(),slot=66;
  engine.setHold({open:false,frozen:false,sealed:true});engine.observe('ChampSelect');engine.setSlots(new Map([[alias,slot]]));
  engine.setPersonal({key,file:'original-path-must-not-be-used',alias:entry.champion,label:query});
  await settle();
  assert.equal(engine.status,'ready',engine.error);
  assert.equal(engine.journal.staged.length,2,'Expected the checked prepared skin plus its slot copy.');
  const overlay=path.join(process.env.APPDATA,'dev.leaguetoolkit.manager','profiles','default','overlay','DATA','FINAL','Champions',`${entry.champion}.wad.client`);
  let base,moved;
  for(let i=0;i<80;i++){
    if(await stat(overlay).then(info=>info.mtimeMs>=begun,()=>false)){
      base=await readWadFileOnDisk(overlay,`data/characters/${alias}/skins/skin0.bin`).catch(()=>null);
      moved=await readWadFileOnDisk(overlay,`data/characters/${alias}/skins/skin${slot}.bin`).catch(()=>null);
      if(base&&moved)break;
    }
    await pause(250);
  }
  assert.ok(base&&moved,'LTK did not build both skin slots into the overlay.');
  assert.ok(parseBin(moved).objects.some(object=>object.hash===binHash(`characters/${alias}/skins/skin${slot}`)));
  console.log(`${query}: prepared package staged in ${Date.now()-begun} ms; LTK built skin0 and skin${slot}; base name ${baseSkinName(base,alias)}.`);
  engine.observe('Lobby');await settle();
  await bridge.ensure();assert.equal(snapshot(await bridge.mods()),before,'Player library differs.');
  console.log('Player library restored. A real match is still required to verify the game DLL and appearance.');
}finally{
  await engine.shutdown();await bridge.quit();
  assert.equal(path.dirname(path.resolve(dir)),path.resolve(tmpdir()));
  assert.ok(path.basename(dir).startsWith('friloverse-prepared-check-'));
  await rm(dir,{recursive:true,force:true});
}
