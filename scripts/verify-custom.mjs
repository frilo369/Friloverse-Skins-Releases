// Every custom and local skin, or just the absolute .fantome paths passed as arguments, through the
// real LTK Manager, the way a pick goes: installed, checked by
// LTK and repaired by its own Repair, on its copy. Says which load and which LTK refuses.
// Originals are hashed before and after and the library is put back. About 5 minutes. Refuses
// during a draft or game, or if LTK is open, and stops if League leaves the lobby.
import {createHash} from 'node:crypto';
import {readFile,readdir,stat} from 'node:fs/promises';
import path from 'node:path';
import {LtkBridge} from '../src/ltk.mjs';
import {assertMachineIdle,leagueBusyReason} from './lib/runtime.mjs';

await assertMachineIdle();

const database=path.join(process.env.LOCALAPPDATA,'friloverse-skins-data','Database');
const roots=[path.join(database,'Custom Skins'),path.join(database,'LocalSkins')],files=[];
const selected=process.argv.slice(2);
if(selected.length){
  for(const file of selected){
    if(!path.isAbsolute(file)||!/\.(fantome|modpkg)$/i.test(file)||!(await stat(file)).isFile())throw new Error('Pass an absolute path to a .fantome or .modpkg file.');
    files.push(file);
  }
}else{
  for(const root of roots)for(const folder of await readdir(root,{withFileTypes:true}).catch(()=>[])){
    if(!folder.isDirectory())continue;
    for(const name of await readdir(path.join(root,folder.name)).catch(()=>[]))if(/\.(fantome|modpkg)$/i.test(name))files.push(path.join(root,folder.name,name));
  }
}
const hash=async file=>createHash('sha1').update(await readFile(file)).digest('hex');
const bridge=new LtkBridge(),groups={'':[],skinhack:[],damaged:[],unknown:[],failed:[]};
const slowest={ms:0,name:''};let originals=0,checked=0;
try{
  await bridge.ensure();
  const before=new Set((await bridge.mods()).map(mod=>mod.id));
  for(const file of files){
    const why=await leagueBusyReason();
    if(why){console.log(`Stopped: ${why}.`);process.exitCode=1;break;}
    const label=path.relative(database,file),original=await hash(file);
    let id='';
    try{
      id=(await bridge.install(file))?.mod?.id;
      if(!id)throw new Error('LTK did not report the installed mod ID.');
      if(selected.length)console.log(`${label} before Repair: ${JSON.stringify(await bridge.checkHealth(id))}`);
      const begun=Date.now(),problem=await bridge.readyMod(id,{repair:!before.has(id)});
      const verdict=await bridge.verdict(id,{timeout:0});
      if(selected.length)console.log(`${label} after Repair: ${JSON.stringify(verdict)}`);
      const took=Date.now()-begun;
      if(took>slowest.ms)Object.assign(slowest,{ms:took,name:label});
      groups[problem||(!verdict?'unknown':'')].push(label);
    }catch(error){groups.failed.push(`${label}: ${String(error.message).slice(0,120)}`);}
    if(id&&!before.has(id))await bridge.uninstall(id).catch(()=>{});
    if(await hash(file)!==original){originals++;console.log(`ORIGINAL CHANGED: ${label}`);}
    checked++;
  }
  console.log(`Checked ${checked} of ${files.length}. Passed LTK preflight: ${groups[''].length}. Skin hack: ${groups.skinhack.length}. Could not be repaired: ${groups.damaged.length}. Unknown: ${groups.unknown.length}. Failed: ${groups.failed.length}.`);
  console.log(`Longest check and Repair: ${slowest.ms} ms (${slowest.name})`);
  for(const [title,list] of [['Skin hack',groups.skinhack],['Could not be repaired',groups.damaged],['No health verdict (not a pass)',groups.unknown],['Failed',groups.failed]])
    if(list.length)console.log(`${title}:\n  ${list.join('\n  ')}`);
  const after=await bridge.mods(),same=after.length===before.size&&after.every(mod=>before.has(mod.id));
  console.log(`Originals changed: ${originals}. Library back as it was: ${same}.`);
  if(originals||!same||groups.unknown.length||groups.failed.length)process.exitCode=1;
}finally{await bridge.quit();}
