// Real-machine check of the bundled LTF bridge: starts LTK Manager through it, imports a
// .fantome through the injected DLL, checks it, starts and stops the patcher, then removes
// the mod and closes the manager. Refuses during a draft or game.
//   node scripts/verify-ltf.mjs --package=<file.fantome>
import {access,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {LtfBridge,ltfAvailable,LAUNCHER,DLL} from '../src/ltf-bridge.mjs';
import {resolveLtkExecutable} from '../src/ltk.mjs';
import {assertMachineIdle} from './lib/runtime.mjs';

await assertMachineIdle({allowLtk:true,allowedPhases:['None','Lobby','EndOfGame','WaitingForStats']});
if(!await ltfAvailable()){console.error(`The bundled LTF files are missing (${LAUNCHER}, ${DLL}).`);process.exit(2);}
const requested=process.argv.find(arg=>arg.startsWith('--package='))?.slice(10);
if(!requested){console.error('Usage: node scripts/verify-ltf.mjs --package=<file.fantome>');process.exit(2);}
const file=path.resolve(requested);
await access(file).catch(()=>{console.error(`Missing: ${file}`);process.exit(2);});
console.log(`Bundled LTF: ${LAUNCHER}`);
console.log(`Package: ${file}`);
const logDir=await mkdtemp(path.join(tmpdir(),'friloverse-ltf-verify-'));
const bridge=new LtfBridge({exePath:await resolveLtkExecutable().catch(()=>null),logDir});
let modId='';
try{
  const ensureAt=Date.now();
  await bridge.ensure();
  console.log(`Launcher + bridge: ${Date.now()-ensureAt} ms on port ${bridge.port}, LTK pid ${bridge.managerPid}`);
  const installed=await bridge.install(file);
  modId=installed.mod.id;
  console.log(`Import: ${installed.kind}, ${modId}`);
  const verdict=await bridge.readyMod(modId,{repair:false});
  console.log(`LTK health: ${verdict||'healthy'}`);
  const patchAt=Date.now();
  const patched=await bridge.patch();
  console.log(`Patcher: ${patched?'scanning':'not started'}, ${Date.now()-patchAt} ms, ${JSON.stringify(await bridge.status())}`);
  await bridge.endPatching();
  console.log(`Patcher stopped: ${JSON.stringify(await bridge.status())}`);
}catch(error){
  console.error(`FAILED: ${error.message}`);
  process.exitCode=1;
}finally{
  if(modId)await bridge.uninstall(modId).catch(error=>console.error(`Could not remove ${modId}: ${error.message}`));
  await bridge.quit().catch(()=>{});
  await rm(logDir,{recursive:true,force:true}).catch(()=>{});
  console.log('Cleaned up.');
}
