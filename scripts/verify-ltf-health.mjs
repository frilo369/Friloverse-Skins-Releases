// Read-only check of the bundled LTF DLL's embedded health shim against a simulated LTK
// window. Does not load a DLL, connect to LTK/League, or change installed mods.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';

const file=process.argv[2]||path.join(path.dirname(fileURLToPath(import.meta.url)),'..','src','native','ltf','LeagueToolFlop.dll');
const bytes=await readFile(file),sha256=createHash('sha256').update(bytes).digest('hex');
// Never evaluate code extracted from an unreviewed binary. A changed DLL needs a new
// static inspection before its embedded script can be admitted to this simulation.
assert.equal(sha256,'d1aa6c75dc32880c16aca36029204230e126e30d5fffdaf225051df796f2d992','This DLL has not been reviewed; inspect it with REA before running its embedded code.');
const start=bytes.indexOf(Buffer.from('\n(function() {\n    if (window.__ltk_health_spoofed)'));
assert.ok(start>=0,'Reviewed health shim was not found.');
const end=bytes.indexOf(0,start);
assert.ok(end>start&&end-start<16384,'Invalid embedded script range.');
const script=new vm.Script(bytes.toString('utf8',start,end),{filename:'reviewed-ltf-health-shim.js'});
const health='plugin:library|get_mod_health_verdicts',mods='plugin:library|get_installed_mods';
const records=[{id:'riot-example'},{id:'custom-yumeko-example'}];

for(const wrapped of [false,true]){
  const actual={
    'riot-example':{modId:'riot-example',health:'healthy'},
    'custom-yumeko-example':{modId:'custom-yumeko-example',health:'error',rules:[{rule:'bin/skinhack',severity:'error'}]},
  };
  const before=JSON.stringify(actual),calls=[];
  const backend=async(command,args)=>{
    calls.push({command,args});
    if(command===mods)return wrapped?{ok:true,value:records}:records;
    if(command===health)return {ok:true,value:actual};
    return {ok:true,value:{forwarded:true}};
  };
  const window={__TAURI_INTERNALS__:{invoke:backend}};
  const context=vm.createContext({window,crypto:{randomUUID:()=> 'fixture-id'}});
  assert.equal(script.runInContext(context,{timeout:1000}),'ok');
  assert.equal(script.runInContext(context,{timeout:1000}),'already');
  const reply=await window.__TAURI_INTERNALS__.invoke(health,{});
  assert.equal(reply.ok,true);
  for(const {id} of records)assert.equal(reply.value[id]?.health,'healthy');
  assert.equal(JSON.stringify(actual),before,'The shim must not change backend findings.');
  assert.ok(!calls.some(call=>call.command===health),'Spoofed UI health must not call the backend health command.');
  const args={filePath:'fixture-only.fantome'};
  const forwarded=await window.__TAURI_INTERNALS__.invoke('plugin:library|install_mod',args);
  assert.equal(forwarded.value.forwarded,true);
  assert.equal(calls.at(-1).args,args);
  console.log(`${wrapped?'Wrapped':'Array'} library: Riot and custom IDs both report healthy; backend findings unchanged; install forwarded unchanged.`);
}
console.log(`DLL SHA-256: ${sha256}`);
console.log('Confirmed UI spoof only in this path. This simulation does not prove game compatibility or bypass the game DLL verification.');
