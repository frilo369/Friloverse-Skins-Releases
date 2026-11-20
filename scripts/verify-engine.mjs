// Runs the real engine against the real LTK Manager, outside a match: loads one
// local converted Riot skin, stages it with the patcher, then undoes everything and compares the
// library with how it started. Refuses during a draft or game, or if LTK is open.
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {processRunning} from '../src/process-list.mjs';
import {LtkBridge,ltkRunning} from '../src/ltk.mjs';
import {RiotCatalogue} from '../src/riot-skins-local.mjs';
import {SkinEngine} from '../src/engine.mjs';
import {assertMachineIdle,ensureZstdRuntime} from './lib/runtime.mjs';

ensureZstdRuntime(import.meta.url);
await assertMachineIdle();

const run=promisify(execFile);
async function parentOfLtk(){
  const script="$m=Get-CimInstance Win32_Process -Filter \"Name='ltk-manager.exe'\" | Select-Object -First 1; if($m){(Get-CimInstance Win32_Process -Filter \"ProcessId=$($m.ParentProcessId)\").Name}";
  return (await run('powershell.exe',['-NoProfile','-Command',script],{windowsHide:true})).stdout.trim();
}
const dataDir=await mkdtemp(path.join(tmpdir(),'friloverse-engine-'));
const catalogue=new RiotCatalogue();
await catalogue.check();
console.log(`Local Riot skins ${[...catalogue.byChampion.values()].reduce((sum,list)=>sum+list.length,0)}`);
const started=Date.now();
const skin=await catalogue.ensure(11,11116);
console.log(`Ready: ${skin.file} (${skin.size} bytes) in ${Date.now()-started} ms`);

const bridge=new LtkBridge();
let passes=0;
const engine=new SkinEngine({bridge,dataDir,settle:0,onChange:()=>{passes++;}});
const pause=ms=>new Promise(done=>setTimeout(done,ms));
const settle=async()=>{await pause(100);for(let i=0;i<600&&engine.busy;i++)await pause(50);};
const library=mods=>JSON.stringify(mods.map(mod=>[mod.id,!!mod.enabled]).sort());
const pick={key:skin.sha,file:skin.file,label:'Master Yi test'};
try{
  await bridge.ensure();
  const before=library(await bridge.mods());
  console.log('Library before:',before);
  await bridge.quit();
  await pause(800);
  engine.setHold({open:false,frozen:false,sealed:true});engine.observe('ChampSelect');
  engine.setPersonal(pick);
  const begun=Date.now();
  await settle();
  console.log(`Staged in ${Date.now()-begun} ms, status ${engine.status}${engine.error?`, error: ${engine.error}`:''}`);
  const parent=await parentOfLtk();
  console.log('LTK Manager patching this match was started by:',parent);
  if(parent!=='explorer.exe'){process.exitCode=1;console.log('LTK\'s game helper would refuse this overlay.');}
  console.log('Patcher host running:',await processRunning('ltk_patcher_host.exe'));
  console.log('Journal:',JSON.stringify(engine.journal));
  if(engine.status!=='ready'||!engine.journal.staged.length){process.exitCode=1;console.log('THE SKIN WAS NOT STAGED:',engine.error);}
  engine.setPersonal(null);
  await settle();
  console.log(`Skin off: status ${engine.status}, LTK running ${await ltkRunning()}`);
  engine.setPersonal(pick);
  await settle();
  console.log(`Back on: status ${engine.status}, started by ${await parentOfLtk()}`);
  engine.observe('Lobby');
  await settle();
  console.log(`Undone: status ${engine.status}, journal ${JSON.stringify(engine.journal)}`);
  await pause(800);
  await bridge.ensure();
  const after=library(await bridge.mods());
  console.log('Library after:',after);
  if(after!==before)process.exitCode=1;
  console.log(after===before?'The library is back as it was.':'THE LIBRARY DIFFERS.');
}finally{
  clearTimeout(engine.timer);clearTimeout(engine.armTimer);
  await engine.shutdown().catch(()=>{});
  await bridge.quit();
  await rm(dataDir,{recursive:true,force:true});
}
await pause(800);
console.log('LTK Manager still running:',await ltkRunning());
