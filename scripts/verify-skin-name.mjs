// The loading-screen name on the real LTK Manager: a prepared custom skin and its name mod are
// staged by the real engine, LTK builds its overlay, and League's text table in that overlay must
// carry the chosen name (LTK 1.33 applies only `StringOverrides`). Restores the player's library,
// never launches League. Needs zstd: run with bundled Node 24, or Electron with ELECTRON_RUN_AS_NODE=1.
import assert from 'node:assert/strict';
import {mkdtemp,readFile,readdir,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {PreparedSkinLibrary} from '../src/prepared-skins.mjs';
import {LtkBridge} from '../src/ltk.mjs';
import {SkinEngine} from '../src/engine.mjs';
import {readWadFileOnDisk} from '../src/skin-slots.mjs';
import {buildNameMod,nameKey,xxh3} from '../src/skin-names.mjs';
import {assertMachineIdle,ensureZstdRuntime} from './lib/runtime.mjs';

ensureZstdRuntime(import.meta.url);
await assertMachineIdle();
const MASK=(1n<<38n)-1n;
function textOf(table,key){
  const count=table.readUInt32LE(4),start=8+count*8,hash=xxh3(key.toLowerCase())&MASK;
  for(let at=8;at<start;at+=8){
    const row=table.readBigUInt64LE(at);
    if((row&MASK)!==hash)continue;
    const from=start+Number(row>>38n);
    return table.toString('utf8',from,table.indexOf(0,from));
  }
  return undefined;
}
const dataDir=path.join(process.env.APPDATA,'friloverse-skins');
const manifest=JSON.parse(await readFile(path.join(dataDir,'prepared-skins','manifest.json'),'utf8'));
const query=process.argv[2]||'Ekko';
const [key,entry]=Object.entries(manifest.entries).find(([,row])=>row.status==='ready'&&(row.label?.includes(query)||row.champion===query))||[];
if(!entry?.champion)throw new Error(`No prepared champion skin matches ${query}.`);
const library=new PreparedSkinLibrary({dataDir}),bridge=new LtkBridge();
const dir=await mkdtemp(path.join(tmpdir(),'friloverse-name-check-'));
const engine=new SkinEngine({bridge,dataDir:dir,settle:0,buildNames:buildNameMod,prepareFile:pick=>library.resolve(pick)});
const pause=ms=>new Promise(done=>setTimeout(done,ms));
const settle=async()=>{
  await pause(50);
  for(let i=0;i<1200&&(engine.busy||engine.waiting);i++)await pause(50);
  assert.equal(engine.busy,false,'Engine did not settle.');
};
const snapshot=mods=>JSON.stringify(mods.map(mod=>[mod.id,!!mod.enabled]).sort());
const label=`Friloverse Check ${Date.now().toString(36)}`,alias=entry.champion.toLowerCase(),slot=0,line=nameKey(alias,slot);
let before;
try{
  await bridge.ensure();before=snapshot(await bridge.mods());await bridge.quit();await bridge.closed();
  const begun=Date.now();
  engine.setHold({open:false,frozen:false,sealed:true});engine.observe('ChampSelect');engine.setSlots(new Map());
  engine.setPersonal({key,file:'original-path-must-not-be-used',alias:entry.champion,label});
  await settle();
  assert.equal(engine.status,'ready',engine.error);
  assert.equal(engine.journal.staged.length,2,'Expected the prepared skin plus its name mod.');
  const localized=path.join(process.env.APPDATA,'dev.leaguetoolkit.manager','profiles','default','overlay','DATA','FINAL','Localized');
  let shown;
  for(let i=0;i<120&&!shown;i++){
    for(const wad of await readdir(localized).catch(()=>[])){
      const file=path.join(localized,wad),locale=wad.split('.')[1]?.toLowerCase();
      if(!/^Global\.[a-z]{2}_[a-z]{2}\.wad\.client$/i.test(wad)||!await stat(file).then(info=>info.mtimeMs>=begun,()=>false))continue;
      const table=await readWadFileOnDisk(file,`data/menu/${locale}/lol.stringtable`).catch(()=>null);
      if(table&&textOf(table,line)===label)shown=wad;
    }
    if(!shown)await pause(250);
  }
  assert.ok(shown,`LTK's overlay text table does not name ${line} "${label}".`);
  console.log(`${entry.label}: LTK wrote "${label}" into ${line} in its overlay ${shown}, ${Date.now()-begun} ms after staging began.`);
  engine.observe('Lobby');await settle();
  await bridge.ensure();assert.equal(snapshot(await bridge.mods()),before,'Player library differs.');
  console.log('Player library restored. A real match is still required to see the loading screen itself.');
}finally{
  await engine.shutdown();await bridge.quit();
  assert.equal(path.dirname(path.resolve(dir)),path.resolve(tmpdir()));
  assert.ok(path.basename(dir).startsWith('friloverse-name-check-'));
  await rm(dir,{recursive:true,force:true});
}
