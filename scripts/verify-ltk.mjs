// Starts LTK Manager hidden, reads its mods and patcher status over Friloverse's own private
// connection, and closes it. Changes no mods. Refuses during a draft or a game, and
// if LTK Manager is already open. The only lasting change is LTK's "start in tray".
import {LtkBridge,ltkRunning} from '../src/ltk.mjs';
import {assertMachineIdle} from './lib/runtime.mjs';

await assertMachineIdle();

const bridge=new LtkBridge();
const started=Date.now();
try{
  await bridge.ensure();
  console.log(`Connected in ${Date.now()-started} ms, LTK Manager ${bridge.version}`);
  const mods=await bridge.mods();
  console.log(`Mods: ${mods.length}`);
  for(const mod of mods)console.log(JSON.stringify(mod).slice(0,700));
  console.log('Patcher:',JSON.stringify(await bridge.status()));
  const settings=await bridge.invoke('plugin:settings|get_settings');
  console.log('startInTray:',settings.startInTray,'leaguePath:',settings.leaguePath,'firstRunComplete:',settings.firstRunComplete);
  const windows=await bridge.evaluate("document.visibilityState+' '+document.title",5000);
  console.log('Page:',windows);
}finally{
  await bridge.quit();
}
await new Promise(done=>setTimeout(done,800));
console.log('LTK Manager still running:',await ltkRunning());
