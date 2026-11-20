// Does the installed LTK Manager honor "enforceSkinhackScan": false? Asks the real one:
// sets the preference, reads the settings back through LTK's own commands, has LTK save them
// the way its window does, and checks one skin it flags. Its in-game check can only be seen
// in a real match (`overlay verified` in its log). Refuses during a match or if LTK is open.
// The library is put back. The preference stays set, as the owner wants it.
import {createRequire} from 'node:module';
import {readFile,readdir} from 'node:fs/promises';
import path from 'node:path';
import {LtkBridge,ltkRunning,settingsFile} from '../src/ltk.mjs';
import {assertMachineIdle} from './lib/runtime.mjs';

const {applyPreference}=createRequire(import.meta.url)('../src/ltk-preference.cjs');
await assertMachineIdle();

const inFile=async()=>JSON.parse(await readFile(settingsFile(),'utf8')).enforceSkinhackScan;
const FLAGGED=process.argv[2]||path.join(process.env.LOCALAPPDATA,'friloverse-skins-data','Database','Custom Skins','Ezreal','Gojo-v1.0.0.fantome');
console.log('Set in the file:',applyPreference(),'| file says:',await inFile());

const bridge=new LtkBridge();
let echoed,afterSave,verdict='not checked';
try{
  await bridge.ensure();
  console.log('LTK Manager version:',bridge.version);
  console.log('File after LTK started:',await inFile());
  const settings=await bridge.invoke('plugin:settings|get_settings');
  echoed=settings?.enforceSkinhackScan;
  console.log('LTK reports the setting as:',echoed===undefined?'(it has no such setting)':echoed);
  await bridge.invoke('plugin:settings|save_settings',{settings});
  afterSave=await inFile();
  console.log('File after LTK saved its settings:',afterSave===undefined?'(LTK removed the key)':afterSave);
  const before=new Set((await bridge.mods()).map(mod=>mod.id));
  const id=(await bridge.install(FLAGGED))?.mod?.id;
  verdict=await bridge.readyMod(id,{repair:!before.has(id)})||'loads';
  console.log(`A skin LTK flags (${path.basename(FLAGGED)}) with the setting off:`,verdict);
  if(id&&!before.has(id))await bridge.uninstall(id);
}finally{await bridge.quit();}
for(let i=0;i<50&&await ltkRunning();i++)await new Promise(done=>setTimeout(done,100));
console.log('Put the preference back after LTK closed:',applyPreference(),'| file says:',await inFile());
const logs=path.join(process.env.APPDATA,'dev.leaguetoolkit.manager','logs');
const newest=(await readdir(logs)).filter(name=>name.endsWith('.log')).sort().at(-1);
const mentions=(await readFile(path.join(logs,newest),'utf8')).split('\n').filter(line=>/enforce.?skinhack/i.test(line)).length;
console.log('Mentions of the setting in LTK\'s log:',mentions);
console.log(echoed===false&&afterSave===false&&verdict==='loads'
  ?'RESULT: honored here. Confirm in a real match.'
  :'RESULT: NOT honored by this LTK Manager: the scan is still on.');
