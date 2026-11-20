import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,writeFile,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {createRequire} from 'node:module';
import net from 'node:net';
import {execFileSync} from 'node:child_process';
import {LtkBridge,parseInstallLocation,prepareQuietStart,readPatcherAtStart,resolveLtkExecutable} from '../src/ltk.mjs';
import {LTK_INSTALLER,installLtk,retireCelestial} from '../src/ltk-install.mjs';

async function withDir(work){
  const dir=await mkdtemp(path.join(tmpdir(),'friloverse-ltk-'));
  try{await work(dir);}finally{await rm(dir,{recursive:true,force:true});}
}

/** A stand-in for the pipes, with what a browser at the other end would answer. */
function fakeChannel(answer=()=>undefined){
  const send=new PassThrough(),receive=new PassThrough(),calls=[],sent=[];
  let open=true,rest='';
  send.on('data',chunk=>{
    const parts=(rest+chunk).split('\0');rest=parts.pop();
    for(const text of parts){
      const message=JSON.parse(text);sent.push(message);
      const result=answer(message);
      if(result!==undefined)receive.write(`${JSON.stringify({id:message.id,...result})}\0`);
    }
  });
  return {send,receive,calls,sent,browserArguments:'--remote-debugging-pipe --remote-debugging-io-pipes=11,12',
    get open(){return open;},share(){calls.push('share');},release(){calls.push('release');},
    close(){if(open){open=false;calls.push('close');send.destroy();receive.destroy();}}};
}

test('the editing connection is two private pipes, and no second program can join',{skip:process.platform!=='win32'},async()=>{
  const {openDebugPipes}=createRequire(import.meta.url)('../src/ltk-pipe.cjs');
  const channel=await openDebugPipes();
  try{
    assert.match(channel.browserArguments,/^--remote-debugging-pipe --remote-debugging-io-pipes=\d+,\d+$/);
    assert.doesNotMatch(channel.browserArguments,/port/);
    assert.equal(channel.open,true);
    const names=execFileSync('powershell',['-NoProfile','-Command',String.raw`[System.IO.Directory]::GetFiles('\\.\pipe\') -match 'friloverse-ltk-'`],{encoding:'utf8'}).trim().split(/\s+/);
    assert.equal(names.length,2);
    for(const name of names){
      assert.match(name,/friloverse-ltk-(in|out)-[0-9a-f]{32}$/);
      const second=net.connect(name);second.on('error',()=>{});
      const joined=await Promise.race([new Promise(done=>second.once('connect',()=>done(true))),new Promise(done=>setTimeout(()=>done(false),300))]);
      second.destroy();
      assert.equal(joined,false,'each pipe already has its one connection');
    }
    channel.share();
  }finally{channel.close();}
  assert.equal(channel.open,false);
});

test('only the editing LTK Manager Friloverse started is contacted',async()=>{
  let launched=0;
  const bridge=new LtkBridge({isRunning:async()=>false});
  bridge.launch=async()=>{launched++;bridge.child={pid:7};};
  bridge.attach=async()=>{};
  await bridge.ensure();assert.equal(launched,1);
  const unknown=new LtkBridge();unknown.channel=fakeChannel();
  await assert.rejects(unknown.attach(),error=>error.plain&&/editing process has closed/.test(error.message));
  unknown.child={pid:7,exitCode:null,signalCode:'SIGTERM'};
  await assert.rejects(unknown.attach(),/editing process has closed/);
  assert.deepEqual(unknown.channel.sent,[],'nothing is sent to pipes without a live editing child');
});

test('commands go to LTK Manager\'s own window over the pipes, and its answers come back',async()=>{
  const channel=fakeChannel(message=>{
    if(message.method==='Target.getTargets')return {result:{targetInfos:[{type:'page',url:'about:blank',targetId:'other'},{type:'page',url:'http://tauri.localhost/',targetId:'ltk'}]}};
    if(message.method==='Target.attachToTarget')return message.params.targetId==='ltk'&&message.params.flatten?{result:{sessionId:'S1'}}:{error:{message:'wrong target'}};
    if(message.method.startsWith('Custom.'))return undefined;
    if(message.method!=='Runtime.evaluate'||message.sessionId!=='S1')return {error:{message:'not for the window'}};
    const {expression}=message.params;
    if(expression.includes('?.invoke'))return {result:{result:{value:true}}};
    if(expression.includes('get_app_info'))return {result:{result:{value:{ok:true,value:{version:'1.33.0'}}}}};
    if(expression.includes('get_settings'))return {result:{result:{value:{ok:true,value:{leaguePath:'C:/LoL',firstRunComplete:true}}}}};
    if(expression.includes('get_installed_mods'))return {result:{result:{value:{ok:true,value:[{id:'ünï'}]}}}};
    if(expression.includes('uninstall_mod'))return {result:{exceptionDetails:{exception:{description:'No such mod'}}}};
    return undefined;
  });
  const {spawned,spawnProcess}=starts();
  const bridge=new LtkBridge({openChannel:async()=>channel,spawnProcess,resolve:async()=>'C:/ltk.exe',isRunning:async()=>false,prepare:async()=>{},pause:async()=>{}});
  await bridge.ensure();
  assert.equal(bridge.connected,true);assert.equal(bridge.version,'1.33.0');
  assert.deepEqual(channel.calls,['share','release'],'the browser\'s ends are shared only while LTK Manager starts');
  assert.equal(spawned.length,1);
  assert.deepEqual(await bridge.mods(),[{id:'ünï'}]);
  await assert.rejects(bridge.uninstall('gone'),/No such mod/);
  // An answer may arrive in pieces, and a piece may hold more than one answer.
  const first=bridge.command('Custom.one',{},1000),second=bridge.command('Custom.two',{},1000);
  const [a,b]=channel.sent.slice(-2).map(message=>Buffer.from(`${JSON.stringify({id:message.id,result:{name:`${message.method} é`}})}\0`));
  const all=Buffer.concat([a,b]);
  channel.receive.write(all.subarray(0,all.length-3));channel.receive.write(all.subarray(all.length-3));
  assert.deepEqual([await first,await second],[{name:'Custom.one é'},{name:'Custom.two é'}]);
  const waiting=bridge.command('Custom.never',{},60000);
  bridge.detach();
  await assert.rejects(waiting,/LTK Manager closed/);
  assert.equal(bridge.connected,false);assert.equal(channel.open,false);
  await assert.rejects(bridge.mods(),/not connected/);
});

test('the installer\'s registered folder is read, with variables expanded',()=>{
  assert.equal(parseInstallLocation('    InstallLocation    REG_SZ    C:\\Program Files\\LTK Manager'),'C:\\Program Files\\LTK Manager');
  assert.equal(parseInstallLocation('    InstallLocation    REG_EXPAND_SZ    %ROOT%\\LTK',{ROOT:'D:\\Games'}),'D:\\Games\\LTK');
  assert.equal(parseInstallLocation('    InstallLocation    REG_SZ    relative\\path'),null);
  assert.equal(parseInstallLocation('nothing here'),null);
});

test('a missing LTK Manager gives plain words',async()=>{
  await assert.rejects(resolveLtkExecutable({env:{ProgramFiles:'C:\\Nope'},query:async()=>{throw new Error('no key');},canAccess:async()=>{throw new Error('no');}}),error=>error.plain&&/setup again/.test(error.message));
});

test('start in tray is set only while LTK Manager is closed, and keeps other settings',()=>withDir(async dir=>{
  const file=path.join(dir,'settings.json');
  await writeFile(file,JSON.stringify({leaguePath:'C:/LoL',startInTray:false,minimizeToTray:false}));
  assert.equal(await prepareQuietStart(file,{isRunning:async()=>true}),false);
  assert.equal(JSON.parse(await readFile(file,'utf8')).startInTray,false);
  assert.equal(await prepareQuietStart(file,{isRunning:async()=>false}),true);
  const saved=JSON.parse(await readFile(file,'utf8'));
  assert.equal(saved.startInTray,true);assert.equal(saved.leaguePath,'C:/LoL');
  assert.equal(await prepareQuietStart(file,{isRunning:async()=>false}),false,'nothing to change the second time');
}));

test('a new PC gets settings that skip LTK Manager\'s welcome window',()=>withDir(async dir=>{
  const file=path.join(dir,'new','settings.json');
  assert.equal(await prepareQuietStart(file,{isRunning:async()=>false,league:async()=>'D:/League'}),true);
  const saved=JSON.parse(await readFile(file,'utf8'));
  assert.equal(saved.firstRunComplete,true);assert.equal(saved.startInTray,true);assert.equal(saved.leaguePath,'D:/League');
}));

test('a damaged settings file is kept aside and replaced, or the patcher would never start',()=>withDir(async dir=>{
  await mkdir(dir,{recursive:true});
  const file=path.join(dir,'settings.json');await writeFile(file,'{oops');
  assert.equal(await prepareQuietStart(file,{isRunning:async()=>false,league:async()=>'D:/League',patcherAtStart:true}),true);
  const saved=JSON.parse(await readFile(file,'utf8'));
  assert.equal(saved.alwaysStartPatcher,true);assert.equal(saved.leaguePath,'D:/League');assert.equal(saved.firstRunComplete,true);
  assert.equal(await readFile(`${file}.broken`,'utf8'),'{oops');
}));

test('an LTK Manager opened some other way is left alone',async()=>{
  const bridge=new LtkBridge({isRunning:async()=>true,spawnProcess:()=>{throw new Error('must not start a second one');}});
  await assert.rejects(bridge.ensure(),error=>error.plain&&/already open/.test(error.message));
});

test('only commands Friloverse needs can be sent, and starting a patcher is not one',async()=>{
  const bridge=new LtkBridge();
  await assert.rejects(bridge.invoke('plugin:library|delete_everything'),/Unsupported/);
  await assert.rejects(bridge.invoke('plugin:patcher|start_patcher'),/Unsupported/);
});

// LTK's game helper refuses an overlay unless the manager is a child of the Windows shell.
function starts(){
  const spawned=[];
  const spawnProcess=(file,args,options)=>{
    spawned.push({file,args,options});
    const child=new EventEmitter();child.unref=()=>{};child.pid=7;
    setImmediate(()=>child.emit('spawn'));
    return child;
  };
  return {spawned,spawnProcess};
}
test('the editing LTK Manager skips the shell and never patches; the patching one does neither',async()=>{
  const {spawned,spawnProcess}=starts();const set=[];const channel=fakeChannel();
  const bridge=new LtkBridge({openChannel:async()=>channel,spawnProcess,resolve:async()=>'C:/ltk.exe',isRunning:async()=>false,hostRunning:async()=>false,prepare:async(_file,options)=>{set.push(options.patcherAtStart);},pause:async()=>{}});
  await bridge.launch();
  assert.deepEqual(spawned[0].args,['--shell-relaunched']);
  assert.equal(spawned[0].options.env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS,channel.browserArguments);
  assert.doesNotMatch(spawned[0].options.env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS,/remote-debugging-port/,'no network port is opened');
  bridge.child=null;
  let hostChecks=0;bridge.hostRunning=async()=>hostChecks++>0;
  await bridge.patch();
  assert.deepEqual(spawned[1].args,[],'it must restart itself through the shell');
  assert.equal(spawned[1].options.env,undefined,'and has no connection to Friloverse');
  assert.deepEqual(set,[false,true]);
  assert.equal(channel.open,false,'the editing pipes are closed before a match is patched');
});

test('a patcher start is given up the moment the skins have changed',async()=>{
  const {spawnProcess}=starts();let looks=0;
  const bridge=new LtkBridge({spawnProcess,resolve:async()=>'C:/ltk.exe',isRunning:async()=>true,hostRunning:async()=>false,prepare:async()=>{},pause:async()=>{}});
  bridge.closed=async()=>{};
  assert.equal(await bridge.patch({stale:()=>++looks>=3}),false);
  assert.equal(looks,3,'not waited for any longer');
  let host=0;bridge.hostRunning=async()=>host++>1;
  assert.equal(await bridge.patch({stale:()=>false}),true);
});

test('a patcher that never starts is reported in plain words',async()=>{
  const {spawnProcess}=starts();
  const bridge=new LtkBridge({spawnProcess,resolve:async()=>'C:/ltk.exe',isRunning:async()=>false,hostRunning:async()=>false,prepare:async()=>{},pause:async()=>{}});
  await assert.rejects(bridge.patch({timeout:0}),error=>error.plain&&/did not start its patcher/.test(error.message));
});

test('LTK Manager is looked up once, and a failed lookup is tried again',async()=>{
  let lookups=0;
  const bridge=new LtkBridge({resolve:async()=>{if(++lookups===1)throw new Error('not yet');return 'C:/ltk.exe';}});
  await assert.rejects(bridge.executable(),/not yet/);
  assert.equal(await bridge.executable(),'C:/ltk.exe');
  assert.equal(await bridge.executable(),'C:/ltk.exe');
  assert.equal(lookups,2);
});

test('LTK\'s own verdict decides whether a skin can load',()=>withDir(async dir=>{
  const file=path.join(dir,'verdicts.json');
  await writeFile(file,JSON.stringify({verdicts:{
    hack:{rules:[{rule:'bin/skinhack',severity:'error'}]},
    fatal:{rules:[{rule:'tex/block-alignment',severity:'fatal'}]},
    warned:{rules:[{rule:'bin/object-link',severity:'warning'}]},
    note:{rules:[{rule:'bin/skinhack',severity:'info'}]},
    clean:{},
  }}));
  const bridge=new LtkBridge({pause:async()=>{}});
  const ready=id=>bridge.readyMod(id,{file,timeout:0});
  assert.equal(await ready('hack'),'skinhack');
  assert.equal(await ready('fatal'),'damaged');
  assert.equal(await ready('warned'),'','warnings do not stop a skin');
  assert.equal(await ready('note'),'');
  assert.equal(await ready('clean'),'');
}));

test('a missing background verdict requests a real check and repairs the custom skin',()=>withDir(async dir=>{
  const file=path.join(dir,'verdicts.json'),bridge=new LtkBridge({pause:async()=>{}});
  const calls=[];
  bridge.checkHealth=async id=>{calls.push(['check',id]);return {modId:id,fixable:1,rules:[{rule:'bin/property-type',severity:'fatal'}]};};
  bridge.repair=async id=>{calls.push(['repair',id]);await writeFile(file,JSON.stringify({verdicts:{[id]:{modId:id,fixable:0,rules:[]}}}));};
  assert.equal(await bridge.readyMod('new-custom',{file,timeout:10}),'');
  assert.deepEqual(calls,[['check','new-custom'],['repair','new-custom']]);
}));

test('no real verdict cannot silently pass preflight',()=>withDir(async dir=>{
  const bridge=new LtkBridge({pause:async()=>{}});
  bridge.checkHealth=async()=>null;
  await assert.rejects(bridge.readyMod('mod',{file:path.join(dir,'absent.json'),timeout:0}),error=>error.plain&&/did not finish checking/.test(error.message));
  bridge.checkHealth=async()=>({modId:'another-mod',fixable:0,rules:[]});
  await assert.rejects(bridge.readyMod('mod',{file:path.join(dir,'absent.json'),timeout:0}),/did not finish checking/);
}));

test('an explicit health check failure is preserved instead of loading an unchecked skin',()=>withDir(async dir=>{
  const bridge=new LtkBridge({pause:async()=>{}});
  bridge.checkHealth=async()=>{throw new Error('The hashtables this check needs are not synced.');};
  await assert.rejects(bridge.readyMod('mod',{file:path.join(dir,'absent.json'),timeout:0}),/hashtables.*not synced/);
}));

/** A stand-in for LTK: each Repair call moves the verdict file on to the next answer. */
async function repairing(dir,answers,options={}){
  const file=path.join(dir,'verdicts.json');let calls=0;
  const save=verdict=>writeFile(file,JSON.stringify({verdicts:{mod:verdict}}));
  await save(answers[0]);
  const bridge=new LtkBridge({pause:async()=>{}});
  bridge.repair=async id=>{assert.equal(id,'mod');calls++;if(answers[calls])await save(answers[calls]);};
  const result=await bridge.readyMod('mod',{file,timeout:10,...options});
  return {result,calls};
}
const fatal={rule:'bin/property-type',severity:'fatal'},hack={rule:'bin/skinhack',severity:'error'};

test('an out-of-date custom skin is repaired by LTK before it loads',()=>withDir(async dir=>{
  const {result,calls}=await repairing(dir,[{fixable:76,rules:[fatal]},{fixable:0,rules:[]}]);
  assert.equal(result,'');assert.equal(calls,1);
}));

test('a healthy skin is not repaired',()=>withDir(async dir=>{
  const {result,calls}=await repairing(dir,[{fixable:0,rules:[]}]);
  assert.equal(result,'');assert.equal(calls,0);
}));

test('Repair runs again for what its first pass skipped',()=>withDir(async dir=>{
  const {result,calls}=await repairing(dir,[{fixable:5,rules:[fatal,hack]},{fixable:1,rules:[hack]},{fixable:0,rules:[]}]);
  assert.equal(result,'');assert.equal(calls,2);
}));

test('a skin named after another skin stays flagged after Repair',()=>withDir(async dir=>{
  const {result,calls}=await repairing(dir,[{fixable:9,rules:[fatal,hack]},{fixable:0,rules:[hack]}]);
  assert.equal(result,'skinhack');assert.equal(calls,1);
}));

test('Repair that never changes the verdict stops, and the last verdict stands',()=>withDir(async dir=>{
  const {result,calls}=await repairing(dir,[{fixable:1,rules:[hack]}]);
  assert.equal(result,'skinhack');assert.equal(calls,1);
}));

test('Repair gives up after a few passes',()=>withDir(async dir=>{
  const {result,calls}=await repairing(dir,[1,2,3,4,5,6].map(n=>({fixable:n,rules:[hack]})));
  assert.equal(result,'skinhack');assert.equal(calls,3);
}));

test('a mod that is not ours is only read',()=>withDir(async dir=>{
  const {result,calls}=await repairing(dir,[{fixable:5,rules:[fatal]}],{repair:false});
  assert.equal(result,'damaged');assert.equal(calls,0);
}));

test('the patcher setting is read safely and keeps other settings when changed',()=>withDir(async dir=>{
  const file=path.join(dir,'settings.json');
  assert.equal(await readPatcherAtStart(file),false,'no file yet');
  await writeFile(file,JSON.stringify({leaguePath:'C:/LoL',alwaysStartPatcher:true}));
  assert.equal(await readPatcherAtStart(file),true);
  await prepareQuietStart(file,{isRunning:async()=>false,patcherAtStart:false});
  assert.equal(await readPatcherAtStart(file),false);
  assert.equal(JSON.parse(await readFile(file,'utf8')).leaguePath,'C:/LoL');
}));

test('quitting closes only the LTK Manager Friloverse started',async()=>{
  const calls=[];const taskkill=async(_tool,args)=>{calls.push(args.join(' '));};
  const ours=new LtkBridge();ours.child={pid:42};
  await ours.quit({taskkill});
  assert.deepEqual(calls,['/F /T /IM ltk-manager.exe'],'never by number: LTK restarts itself, and a number can come to mean another program');
  calls.length=0;
  const theirs=new LtkBridge();
  await theirs.quit({taskkill});
  assert.deepEqual(calls,[],'no editing child means the player opened it');
});

test('the app and the setup download the same LTK Manager',async()=>{
  const setup=await readFile(new URL('../scripts/complete-setup.nsi',import.meta.url),'utf8');
  assert.ok(setup.includes(LTK_INSTALLER.url));
  assert.ok(setup.includes(LTK_INSTALLER.sha256.toUpperCase()));
});

test('only the official installer with the expected hash is ever run',()=>withDir(async dir=>{
  const {createHash}=await import('node:crypto');
  const bytes=Buffer.from('installer');
  const installer={url:'https://example.test/setup.exe',sha256:createHash('sha256').update(bytes).digest('hex')};
  const ran=[];const elevate=async file=>{ran.push(await readFile(file));};
  assert.equal(await installLtk({dir,installer,fetchFn:async()=>new Response(bytes),elevate,resolve:async()=>'C:/ltk.exe'}),'C:/ltk.exe');
  assert.deepEqual(ran,[bytes]);
  ran.length=0;
  await assert.rejects(installLtk({dir,installer,fetchFn:async()=>new Response('tampered'),elevate,resolve:async()=>'x'}),/damaged/);
  assert.deepEqual(ran,[],'a wrong file is never started');
  await assert.rejects(installLtk({dir,installer,fetchFn:async()=>new Response(bytes),elevate:async()=>{throw new Error('The operation was canceled by the user');},resolve:async()=>'x'}),/permission/);
  const {readdir}=await import('node:fs/promises');
  assert.deepEqual(await readdir(dir),[],'no installer is left behind');
}));

test('Celestial is only closed if it is running',async()=>{
  let kills=0;const kill=async()=>{kills++;};
  await retireCelestial({running:async()=>false,kill});assert.equal(kills,0);
  await retireCelestial({running:async()=>true,kill});assert.equal(kills,1);
});

test('settings a moment locked for reading are read, and stay locked is said plainly',()=>withDir(async dir=>{
  const file=path.join(dir,'settings.json');await writeFile(file,JSON.stringify({leaguePath:'C:/LoL'}));
  let refusals=2;
  const readText=async(...args)=>{if(refusals-->0)throw Object.assign(new Error('locked'),{code:'EBUSY'});return readFile(...args);};
  assert.equal(await prepareQuietStart(file,{isRunning:async()=>false,readText,pause:async()=>{},patcherAtStart:true}),true);
  assert.equal(JSON.parse(await readFile(file,'utf8')).alwaysStartPatcher,true);
  await assert.rejects(prepareQuietStart(file,{isRunning:async()=>false,pause:async()=>{},readText:async()=>{throw Object.assign(new Error('locked'),{code:'EPERM'});}}),error=>error.plain&&/busy/.test(error.message));
}));

test('an LTK Manager left open gives way to a pick, but not to a draft with none',async()=>{
  const calls=[];let running=true;
  const bridge=new LtkBridge({openChannel:async()=>fakeChannel(),isRunning:async()=>running,hostRunning:async()=>false,pause:async()=>{},
    resolve:async()=>'C:/LTK/ltk-manager.exe',prepare:async()=>false,
    taskkill:async(_tool,args)=>{calls.push(args.join(' '));running=false;},
    spawnProcess:()=>{calls.push('start');return {pid:7,once(event,done){if(event==='spawn')done();},unref(){}};}});
  await assert.rejects(bridge.ensure(),/already open/);
  assert.deepEqual(calls,[]);
  await assert.rejects(bridge.ensure({takeOver:true,timeout:0}),/did not answer/);
  assert.deepEqual(calls.slice(0,2),['/F /T /IM ltk-manager.exe','start']);
});

test('one that cannot be closed still says what to do',async()=>{
  const bridge=new LtkBridge({isRunning:async()=>true,hostRunning:async()=>false,pause:async()=>{await new Promise(done=>setTimeout(done,1));},taskkill:async()=>{}});
  const closed=bridge.closed.bind(bridge);bridge.closed=()=>closed(20);
  await assert.rejects(bridge.ensure({takeOver:true}),error=>error.plain&&/already open/.test(error.message));
});

test('closing ends a patcher host that outlived LTK Manager',async()=>{
  const calls=[];let host=true;
  const bridge=new LtkBridge({isRunning:async()=>false,hostRunning:async()=>host,pause:async()=>{await new Promise(done=>setTimeout(done,2));},
    taskkill:async(_tool,args)=>{calls.push(args.at(-1));if(args.at(-1)==='ltk_patcher_host.exe')host=false;}});
  // Windows timers tick every 15.6 ms: too short a limit can pass before the halfway nudge.
  await bridge.closed(400);
  assert.deepEqual(calls,['ltk-manager.exe','ltk_patcher_host.exe']);
});

test('ending a match closes LTK Manager by name, even with an old process number at hand',async()=>{
  const calls=[];
  const bridge=new LtkBridge({isRunning:async()=>false,hostRunning:async()=>false,taskkill:async(_tool,args)=>{calls.push(args.join(' '));}});
  bridge.patchChild={pid:4242};
  await bridge.endPatching();
  assert.deepEqual(calls,['/F /T /IM ltk-manager.exe']);
});

test('an LTK Manager that hangs is closed, so the next try starts from nothing',async()=>{
  const calls=[];
  const bridge=new LtkBridge({isRunning:async()=>true,hostRunning:async()=>false,taskkill:async(_tool,args)=>{calls.push(args.join(' '));}});
  bridge.child={pid:7};bridge.channel=fakeChannel();
  await assert.rejects(bridge.ensure({timeout:0}),/did not answer/);
  assert.deepEqual(calls,['/F /T /IM ltk-manager.exe']);
});

test('Friloverse\'s own editing LTK Manager that lost its pipes is replaced, not blamed on the player',async()=>{
  const calls=[];let running=true;
  const bridge=new LtkBridge({openChannel:async()=>fakeChannel(),isRunning:async()=>running,hostRunning:async()=>false,pause:async()=>{},
    resolve:async()=>'C:/LTK/ltk-manager.exe',prepare:async()=>false,
    taskkill:async(_tool,args)=>{calls.push(args.join(' '));running=false;},
    spawnProcess:()=>{calls.push('start');return {pid:8,once(event,done){if(event==='spawn')done();},unref(){}};}});
  bridge.child={pid:7};
  await assert.rejects(bridge.ensure({timeout:0}),/did not answer/);
  assert.deepEqual(calls.slice(0,2),['/F /T /IM ltk-manager.exe','start']);
});

test('missingFromOverlay reads the overlay LTK says it built',async()=>{
  const {missingFromOverlay}=await import('../src/ltk.mjs');
  const {writeWad}=await import('../src/skin-slots.mjs');
  const {mkdir,mkdtemp,rm,writeFile}=await import('node:fs/promises');
  const {tmpdir}=await import('node:os');
  const dir=await mkdtemp(path.join(tmpdir(),'friloverse-overlay-'));
  try{
    const logs=path.join(dir,'logs'),root=path.join(dir,'overlay'),champions=path.join(root,'DATA','FINAL','Champions');
    await mkdir(logs);
    assert.deepEqual(await missingFromOverlay(['Aatrox'],logs),[],'no log: cannot tell');
    await writeFile(path.join(logs,'ltk-manager.2026-01-01.log'),`old line\n2026-11-06T20:46:22.917676Z  INFO ltk_manager_core::patching::thread: Using overlay root: ${path.join(dir,'old')}\n2026-11-06T20:47:22.917676Z  INFO ltk_manager_core::patching::thread: Using overlay root: ${root}\r\nlater line\n`);
    assert.deepEqual(await missingFromOverlay(['Aatrox'],logs),[],'no overlay folder: cannot tell');
    await mkdir(champions,{recursive:true});
    await writeFile(path.join(champions,'XinZhao.wad.client'),'');
    await writeFile(path.join(champions,'Viktor.en_US.wad.client'),'');
    await writeFile(path.join(champions,'Zed.wad.client.tmp'),'');
    assert.deepEqual(await missingFromOverlay(['xinzhao','Viktor','Zed','Aatrox'],logs),['Zed','Aatrox']);
    const slots=new Map([['XinZhao',6],['Viktor',9]]);
    await writeFile(path.join(champions,'XinZhao.wad.client'),writeWad([
      {file:'data/characters/xinzhao/skins/skin0.bin',bytes:Buffer.from('base')},
      {file:'data/characters/xinzhao/skins/skin6.bin',bytes:Buffer.from('selected')},
    ]));
    await writeFile(path.join(champions,'Viktor.wad.client'),writeWad([
      {file:'data/characters/viktor/skins/skin0.bin',bytes:Buffer.from('base')},
      {file:'data/characters/viktor/skins/skin8.bin',bytes:Buffer.from('previous selection')},
    ]));
    assert.deepEqual(await missingFromOverlay(['XinZhao','Viktor'],logs,slots),['Viktor']);
  }finally{await rm(dir,{recursive:true,force:true});}
});

function patchBridge(t,{running=()=>true,hostAfter=Infinity}){
  let clock=1000,launched=false;
  t.mock.method(Date,'now',()=>clock);
  const bridge=new LtkBridge({
    resolve:async()=>'ltk-manager.exe',prepare:async()=>false,taskkill:async()=>{},
    spawnProcess:()=>{launched=true;const child=new EventEmitter();child.unref=()=>{};queueMicrotask(()=>child.emit('spawn'));return child;},
    isRunning:async()=>launched&&running(),
    hostRunning:async()=>launched&&clock>=1000+hostAfter,
    pause:async()=>{clock+=500;}});
  return bridge;
}
test('a slow overlay build is waited for, as killing it only starts another', async t=>{
  await patchBridge(t,{hostAfter:45000}).patch();
});
test('an LTK Manager that has closed is not waited for', async t=>{
  await assert.rejects(patchBridge(t,{running:()=>false}).patch(),/closed before its patcher started/);
  assert.ok(Date.now()-1000<10000);
});
