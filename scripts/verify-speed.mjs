// Times the real engine on the real LTK Manager, outside a match: from choosing a skin to
// LTK's patcher scanning for the game, for a first pick and for changing to another skin.
// The time that matters comes from LTK's own log. Undoes everything; refuses during a
// draft or game, or if LTK is open.
import {access,mkdtemp,readFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {LtkBridge,ltkRunning} from '../src/ltk.mjs';
import {RiotCatalogue} from '../src/riot-skins-local.mjs';
import {SkinEngine} from '../src/engine.mjs';
import {assertMachineIdle,ensureZstdRuntime} from './lib/runtime.mjs';

ensureZstdRuntime(import.meta.url);
await assertMachineIdle();

const pause=ms=>new Promise(done=>setTimeout(done,ms));
const logs=path.join(process.env.APPDATA,'dev.leaguetoolkit.manager','logs');
/** When LTK's patcher began scanning, by its own log, at or after this moment. */
async function scanStarted(after){
  const newest=(await readdir(logs)).filter(name=>name.endsWith('.log')).sort().at(-1);
  for(let i=0;i<40;i++){
    const text=await readFile(path.join(logs,newest),'utf8');
    for(const line of text.split('\n').reverse()){
      if(!line.includes('session started: scanning for game'))continue;
      const at=Date.parse(line.slice(0,27));
      if(at>=after)return at;
      break;
    }
    await pause(100);
  }
  return null;
}

const dataDir=await mkdtemp(path.join(tmpdir(),'friloverse-speed-'));
const catalogue=new RiotCatalogue();
await catalogue.check();
const [first,second]=(await catalogue.forChampion(11)).slice(0,2);
const fresh=Date.now();
const one=await catalogue.ensure(11,first.id);
console.log(`Downloading one skin (${one.size} bytes): ${Date.now()-fresh} ms`);
const two=await catalogue.ensure(11,second.id);
const pick=skin=>({key:skin.sha,file:skin.file,label:`Skin ${skin.id}`,trusted:true});

const bridge=new LtkBridge();
const steps=[];let mark=0;
for(const name of ['endPatching','ensure','install','repair','readyMod','patch','quit']){
  const real=bridge[name].bind(bridge);
  bridge[name]=async(...args)=>{const begun=Date.now();try{return await real(...args);}finally{steps.push(`${name} ${begun-mark}+${Date.now()-begun}`);}};
}
const engine=new SkinEngine({bridge,dataDir});
const finished=async()=>{for(let i=0;i<1600&&(engine.busy||engine.applied!==engine.signature());i++)await pause(25);};
async function measure(label,file){
  steps.length=0;mark=Date.now();
  engine.setPersonal(file);
  await finished();
  const ready=Date.now()-mark,scan=await scanStarted(mark);
  console.log(`${label}: LTK scanning after ${scan?scan-mark:'?'} ms; Friloverse says ready after ${ready} ms, status ${engine.status}${engine.error?` (${engine.error})`:''}`);
  console.log(`  ${steps.join(', ')}`);
  return scan?scan-mark:null;
}
try{
  const begun=Date.now();
  engine.setHold({open:false,frozen:false,sealed:true});engine.observe('ChampSelect');
  await pause(50);await finished();
  console.log(`LTK open and waiting after ${Date.now()-begun} ms`);
  // A real draft leaves time before the first pick; give any start-up work that time.
  await pause(4000);
  console.log(`Draft start to first pick: ${Date.now()-begun} ms; LTK open and waiting: ${bridge.connected}`);
  const results=[await measure('First pick',pick(one)),await measure('Changing skin',pick(two))];
  const custom=path.join(process.env.LOCALAPPDATA,'friloverse-skins-data','Database','Custom Skins','Ahri','Mint Ahri.fantome');
  await access(custom).then(()=>measure('Changing to a custom skin (Mint Ahri)',{key:'c'.repeat(40),file:custom,label:'Mint Ahri'}),()=>console.log('No Mint Ahri here to time.'));
  engine.setPersonal(null);await finished();
  console.log(`Skin off: status ${engine.status}, LTK open and waiting ${bridge.connected}`);
  console.log(`Result: first pick ${results[0]} ms, changing skin ${results[1]} ms`);
  engine.observe('Lobby');await pause(50);for(let i=0;i<400&&engine.busy;i++)await pause(25);
  console.log(`Undone: status ${engine.status}, journal ${JSON.stringify(engine.journal)}`);
}finally{
  clearTimeout(engine.timer);clearTimeout(engine.armTimer);
  await engine.shutdown().catch(()=>{});
  await bridge.quit();
  await rm(dataDir,{recursive:true,force:true});
}
await pause(800);
console.log('LTK Manager still running:',await ltkRunning());
