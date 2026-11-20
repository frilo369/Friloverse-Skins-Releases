import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import net from 'node:net';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {LtfBridge,ltfAvailable} from '../src/ltf-bridge.mjs';

const wait=ms=>new Promise(done=>setTimeout(done,ms));

async function withDir(run){
  const dir=await mkdtemp(path.join(tmpdir(),'friloverse-ltf-'));
  try{return await run(dir);}finally{await rm(dir,{recursive:true,force:true});}
}

test('the bundled LTF files are found, and a missing pair is not',()=>withDir(async dir=>{
  const tools=path.join(dir,'ltf');await mkdir(tools,{recursive:true});
  await writeFile(path.join(tools,'ltk_launcher.exe'),'x');
  await writeFile(path.join(tools,'LeagueToolFlop.dll'),'x');
  assert.equal(await ltfAvailable({launcher:path.join(tools,'ltk_launcher.exe'),dll:path.join(tools,'LeagueToolFlop.dll')}),true);
  assert.equal(await ltfAvailable({launcher:path.join(tools,'missing.exe'),dll:path.join(tools,'LeagueToolFlop.dll')}),false);
}));

/** A stand-in for the injected DLL: one JSON line in, one out, on a real loopback port. */
async function fakeBridge(handle){
  const seen=[];
  const server=net.createServer(socket=>{
    socket.setEncoding('utf8');let buffer='';
    socket.on('data',chunk=>{
      buffer+=chunk;
      const end=buffer.indexOf('\n');
      if(end<0)return;
      const request=JSON.parse(buffer.slice(0,end));buffer=buffer.slice(end+1);
      seen.push(request);
      socket.write(`${JSON.stringify(handle(request))}\n`);
    });
  });
  await new Promise(done=>server.listen(0,'127.0.0.1',done));
  return {port:server.address().port,seen,close:()=>new Promise(done=>server.close(done))};
}

function fakeChild(pid){
  const child=new EventEmitter();
  child.stdout=new EventEmitter();
  child.stdout.setEncoding=()=>{};
  setImmediate(()=>{child.stdout.emit('data',`LTK_MANAGER_PID=${pid}\r\n`);child.emit('exit',0);});
  return child;
}

test('a manager the player opened is left alone until a skin is waiting for it',async()=>{
  let launches=0,killed=0;
  const bridge=new LtfBridge({launcher:'x',dll:'x',dataDir:tmpdir(),pause:()=>wait(1),
    isRunning:async()=>true,hostRunning:async()=>false,
    taskkill:async()=>{killed++;},launch:()=>{launches++;throw new Error('must not launch');}});
  await assert.rejects(bridge.ensure(),/already open/);
  assert.equal(launches,0);assert.equal(killed,0,'no manager is closed while no pick needs the bridge');
});

test('the bridge starts LTK through the bundled launcher, imports a skin and starts its patcher',()=>withDir(async dir=>{
  const bridgeDir=path.join(dir,'LTKBridge');await mkdir(bridgeDir,{recursive:true});
  let phase='idle',fixable=1,handled=[];
  const TOKEN='a'.repeat(32),PID=4242;
  const server=await fakeBridge(request=>{
    handled.push(request);
    if(request.cmd==='hello')return {ok:true,service:'LTKBridge',pid:PID,port:server.port};
    if(request.token!==TOKEN)return {ok:false,error:'unauthorized: missing or wrong token'};
    if(request.cmd==='patcher_status')return {ok:true,response:{ok:true,value:{running:phase!=='idle',phase,session:null}}};
    if(request.cmd==='start_patcher'){phase='patching';return {ok:true,response:{ok:true,value:null}};}
    if(request.cmd==='stop_patcher'){phase='idle';return {ok:true,response:{ok:true,value:null}};}
    if(request.cmd==='health_check_off')return {ok:true,changed:false};
    if(request.cmd==='list')return {ok:true,library:[{id:'mod-1',enabled:true,slug:'a-skin',storage:'archive',format:'fantome',modDir:'x'}]};
    if(request.cmd==='import')return {ok:true,response:{ok:true,value:{kind:'installed',mod:{id:'mod-2',slug:'b-skin',storage:'archive',format:'fantome',hasArchive:true,modDir:'x'}}}};
    if(request.cmd==='check_mod_health')return {ok:true,response:{ok:true,value:{modId:request.modId,health:'healthy',fixable:fixable--,counts:{fatals:0},rules:[]}}};
    if(request.cmd==='repair_mod')return {ok:true,response:{ok:true,value:null}};
    if(request.cmd==='toggle')return {ok:true,modId:request.target,response:{ok:true,value:null}};
    if(request.cmd==='uninstall')return {ok:true,modId:request.target,response:{ok:true,value:null}};
    if(request.cmd==='kill')return {ok:true,response:{ok:true,value:null}};
    return {ok:false,error:`unknown ${request.cmd}`};
  });
  let launched=0,launchArgs=[];
  const bridge=new LtfBridge({
    launcher:path.join(dir,'ltk_launcher.exe'),dll:path.join(dir,'LeagueToolFlop.dll'),
    exePath:'C:\\Program Files\\LTK Manager\\ltk-manager.exe',logDir:path.join(dir,'logs'),
    dataDir:dir,pause:()=>wait(1),portFile:path.join(bridgeDir,'port.txt'),tokenFile:path.join(bridgeDir,'token.txt'),
    isRunning:async()=>false,hostRunning:async()=>false,taskkill:async()=>{},
    launch:args=>{launched++;launchArgs=args;setImmediate(async()=>{await mkdir(bridgeDir,{recursive:true});await writeFile(path.join(bridgeDir,'port.txt'),String(server.port));await writeFile(path.join(bridgeDir,'token.txt'),TOKEN);});return fakeChild(PID);},
  });
  try{
    await bridge.ensure();
    assert.equal(launched,1);
    assert.deepEqual(launchArgs.slice(0,4),['--quiet','--exe','C:\\Program Files\\LTK Manager\\ltk-manager.exe','--log-dir']);
    assert.equal(bridge.connected,true);
    assert.equal(bridge.managerPid,PID);
    assert.equal(await bridge.readyMod('mod-1'),'');
    const installed=await bridge.install('C:\\a.fantome');
    assert.equal(installed.kind,'installed');
    assert.equal(installed.mod.id,'mod-2');
    assert.deepEqual((await bridge.mods()).map(mod=>mod.id),['mod-1']);
    await bridge.toggle('mod-1',false);
    assert.equal(await bridge.patch(),true);
    assert.equal((await bridge.status()).phase,'patching');
    await bridge.endPatching();
    assert.equal((await bridge.status()).phase,'idle');
    await bridge.uninstall('mod-1');
    assert.ok(handled.some(request=>request.cmd==='health_check_off'&&request.token===TOKEN));
  }finally{await bridge.quit();await server.close();}
}));

test('a manager closed from its tray or crashed mid-draft is started again, not kept as connected (12.6)',()=>withDir(async dir=>{
  const bridgeDir=path.join(dir,'LTKBridge');await mkdir(bridgeDir,{recursive:true});
  const handler=token=>request=>{
    if(request.cmd==='hello')return {ok:true,service:'LTKBridge',pid:4242};
    if(request.token!==token)return {ok:false,error:'unauthorized: missing or wrong token'};
    if(request.cmd==='patcher_status')return {ok:true,response:{ok:true,value:{running:false,phase:'idle',session:null}}};
    return {ok:true,response:{ok:true,value:null}};
  };
  const first=await fakeBridge(handler('d'.repeat(32)));
  let second=null,launches=0;
  const bridge=new LtfBridge({launcher:'x',dll:'x',dataDir:dir,pause:()=>wait(1),
    isRunning:async()=>false,hostRunning:async()=>false,taskkill:async()=>{},
    portFile:path.join(bridgeDir,'port.txt'),tokenFile:path.join(bridgeDir,'token.txt'),
    launch:()=>{launches++;setImmediate(async()=>{second=await fakeBridge(handler('e'.repeat(32)));
      await writeFile(path.join(bridgeDir,'port.txt'),String(second.port));await writeFile(path.join(bridgeDir,'token.txt'),'e'.repeat(32));});return fakeChild(4242);}});
  try{
    bridge.port=first.port;bridge.token='d'.repeat(32);bridge.linked=true;
    await bridge.ensure({takeOver:true});
    assert.equal(launches,0,'a manager that still answers is kept');
    await first.close();
    // A patch was running: taking it down must not fail on the manager that has gone.
    await bridge.endPatching();
    assert.equal(bridge.connected,false,'a refused connection drops the link');
    bridge.port=first.port;bridge.token='d'.repeat(32);bridge.linked=true;
    await bridge.ensure({takeOver:true});
    assert.equal(launches,1,'the gone manager is replaced');
    assert.equal(bridge.connected,true);assert.equal(bridge.token,'e'.repeat(32));
    assert.equal((await bridge.status()).phase,'idle');
  }finally{await second?.close();}
}));

test('a missing mod and a bad token are reported in the engine\'s own shapes',()=>withDir(async dir=>{
  const bridgeDir=path.join(dir,'LTKBridge');await mkdir(bridgeDir,{recursive:true});
  const TOKEN='b'.repeat(32);
  const server=await fakeBridge(request=>{
    if(request.token!==TOKEN)return {ok:false,error:'unauthorized: missing or wrong token'};
    if(request.cmd==='patcher_status')return {ok:true,response:{ok:true,value:{running:false,phase:'idle',session:null}}};
    if(request.cmd==='uninstall')return {ok:true,response:{ok:false,error:{code:'MOD_NOT_FOUND',modId:request.target}}};
    if(request.cmd==='stop_patcher')return {ok:true,response:{ok:false,error:{code:'PATCHER',error:{kind:'NOT_RUNNING'}}}};
    return {ok:true,response:{ok:true,value:null}};
  });
  await writeFile(path.join(bridgeDir,'port.txt'),String(server.port));
  await writeFile(path.join(bridgeDir,'token.txt'),TOKEN);
  const bridge=new LtfBridge({launcher:'x',dll:'x',dataDir:dir,pause:()=>wait(1),
    isRunning:async()=>false,hostRunning:async()=>false,taskkill:async()=>{},
    launch:()=>{throw new Error('should not launch');},portFile:path.join(bridgeDir,'port.txt'),tokenFile:path.join(bridgeDir,'token.txt')});
  try{
    bridge.port=server.port;bridge.token=TOKEN;bridge.linked=true;
    await assert.rejects(bridge.uninstall('gone'),error=>error.code==='MOD_NOT_FOUND');
    await bridge.stop();
    bridge.token='c'.repeat(32);
    await assert.rejects(bridge.status(),/unauthorized/);
  }finally{await server.close();}
}));

test('nested PATCHER errors unwrap their kind, fail fast on real errors, and retry ALREADY_RUNNING',()=>withDir(async dir=>{
  const TOKEN='1'.repeat(32);
  let mode='elevated',running=false,phase='idle',starts=0;
  const server=await fakeBridge(request=>{
    if(request.token!==TOKEN)return {ok:false,error:'unauthorized'};
    if(request.cmd==='patcher_status')return {ok:true,response:{ok:true,value:{running,phase,session:null}}};
    if(request.cmd==='start_patcher'){
      starts++;
      if(mode==='elevated')return {ok:true,response:{ok:false,error:{code:'PATCHER',error:{kind:'LEAGUE_ELEVATED'}}}};
      if(mode==='already'&&starts===1){
        running=true;phase='stopping';
        setTimeout(()=>{running=false;phase='idle';},15);
        return {ok:true,response:{ok:false,error:{code:'PATCHER',error:{kind:'ALREADY_RUNNING'}}}};
      }
      if(mode==='failed'){running=false;phase='failed';return {ok:true,response:{ok:true,value:null}};}
      running=true;phase='patching';return {ok:true,response:{ok:true,value:null}};
    }
    return {ok:true,response:{ok:true,value:null}};
  });
  const bridge=new LtfBridge({launcher:'x',dll:'x',dataDir:dir,pause:()=>wait(5),idleGrace:20,
    portFile:path.join(dir,'p'),tokenFile:path.join(dir,'t'),isRunning:async()=>false,hostRunning:async()=>false,taskkill:async()=>{}});
  bridge.port=server.port;bridge.token=TOKEN;bridge.linked=true;
  try{
    await assert.rejects(bridge.patch(),error=>error.code==='LEAGUE_ELEVATED'&&/administrator/i.test(error.message));
    mode='already';starts=0;running=false;phase='idle';
    assert.equal(await bridge.patch(),true);
    assert.equal(starts,2,'ALREADY_RUNNING waits for idle then retries start_patcher');
    mode='failed';running=false;phase='idle';
    await assert.rejects(bridge.patch(),/patcher failed/i);
  }finally{await server.close();}
}));

test('InstallKind.UPDATED is preserved and unreadable paths fall back to inline data_b64',()=>withDir(async dir=>{
  const TOKEN='2'.repeat(32);
  const sample=path.join(dir,'skin.fantome');
  await writeFile(sample,'fantome-bytes');
  let sawB64='',mode='updated';
  const server=await fakeBridge(request=>{
    if(request.token!==TOKEN)return {ok:false,error:'unauthorized'};
    if(request.cmd==='import'){
      if(mode==='updated')return {ok:true,response:{ok:true,value:{kind:'updated',mod:{id:'user-mod-1'}}}};
      if(!request.data_b64)return {ok:false,error:'cannot read file: access denied'};
      sawB64=request.data_b64;
      return {ok:true,response:{ok:true,value:{kind:'installed',mod:{id:'inline-1'}}}};
    }
    return {ok:true,response:{ok:true,value:null}};
  });
  const bridge=new LtfBridge({launcher:'x',dll:'x',dataDir:dir,pause:()=>wait(1),
    portFile:path.join(dir,'p'),tokenFile:path.join(dir,'t'),isRunning:async()=>false,hostRunning:async()=>false,taskkill:async()=>{}});
  bridge.port=server.port;bridge.token=TOKEN;bridge.linked=true;
  try{
    const updated=await bridge.install(sample);
    assert.equal(updated.kind,'updated');
    mode='inline';
    const inlined=await bridge.install(sample);
    assert.equal(inlined.kind,'installed');
    assert.equal(Buffer.from(sawB64,'base64').toString('utf8'),'fantome-bytes');
  }finally{await server.close();}
}));

test('waitForBridge avoids pairing a new port with an old token, polls CDP readiness, and cleans up on failure',()=>withDir(async dir=>{
  const bridgeDir=path.join(dir,'LTKBridge');await mkdir(bridgeDir,{recursive:true});
  const OLD_TOKEN='a'.repeat(32),NEW_TOKEN='f'.repeat(32),PID=9191;
  await writeFile(path.join(bridgeDir,'port.txt'),'46321');
  await writeFile(path.join(bridgeDir,'token.txt'),OLD_TOKEN);
  let cdpTries=0;
  const server=await fakeBridge(request=>{
    if(request.cmd==='hello')return {ok:true,service:'LTKBridge',pid:PID,port:server.port};
    if(request.token!==NEW_TOKEN)return {ok:false,error:'unauthorized'};
    if(request.cmd==='patcher_status'){
      if(++cdpTries<3)return {ok:false,error:"cdp unavailable: TypeError: Cannot read properties of undefined (reading 'invoke')"};
      return {ok:true,response:{ok:true,value:{running:false,phase:'idle',session:null}}};
    }
    return {ok:true,response:{ok:true,value:null}};
  });
  const bridge=new LtfBridge({launcher:'x',dll:'x',dataDir:dir,pause:()=>wait(5),
    portFile:path.join(bridgeDir,'port.txt'),tokenFile:path.join(bridgeDir,'token.txt'),
    isRunning:async()=>false,hostRunning:async()=>false,taskkill:async()=>{},
    launch:()=>{
      // Simulate BroadcastPort writing port.txt BEFORE token.txt.
      setTimeout(async()=>{await writeFile(path.join(bridgeDir,'port.txt'),String(server.port));},5);
      setTimeout(async()=>{await writeFile(path.join(bridgeDir,'token.txt'),NEW_TOKEN);},25);
      return fakeChild(PID);
    }});
  try{
    await bridge.ensure();
    assert.equal(bridge.token,NEW_TOKEN);
    assert.equal(cdpTries,3,'polled past transient CDP startup errors');
  }finally{await server.close();}

  // Verify failed startup kills spawned managerPid and maps exit codes 4 vs 6 accurately.
  const killed=[];
  const failChild=code=>{const c=new EventEmitter();c.stdout=new EventEmitter();c.stdout.setEncoding=()=>{};setImmediate(()=>c.emit('exit',code));return c;};
  const b4=new LtfBridge({launcher:'x',dll:'x',dataDir:dir,pause:()=>wait(1),isRunning:async()=>false,hostRunning:async()=>false,taskkill:async()=>{},launch:()=>failChild(4)});
  await assert.rejects(b4.ensure(),/could not inject/i);
  const b6=new LtfBridge({launcher:'x',dll:'x',dataDir:dir,pause:()=>wait(1),isRunning:async()=>false,hostRunning:async()=>false,taskkill:async()=>{},launch:()=>failChild(6)});
  await assert.rejects(b6.ensure(),/exited before/i);
  const badHello=await fakeBridge(()=>({ok:true,service:'LTKBridge',pid:1111}));
  const bOrphan=new LtfBridge({launcher:'x',dll:'x',dataDir:dir,pause:()=>wait(1),
    portFile:path.join(bridgeDir,'p2'),tokenFile:path.join(bridgeDir,'t2'),
    isRunning:async()=>false,hostRunning:async()=>false,
    taskkill:async(_exe,args)=>{killed.push(args);},
    launch:()=>{
      setImmediate(async()=>{await writeFile(path.join(bridgeDir,'p2'),String(badHello.port));await writeFile(path.join(bridgeDir,'t2'),'9'.repeat(32));});
      return fakeChild(8888);
    }});
  try{
    await assert.rejects(bOrphan.ensure(),/another LTK Manager/i);
    assert.ok(killed.some(args=>args.includes('8888')),'spawned manager pid is terminated when handshake fails');
  }finally{await badHello.close();}
}));

test('a launcher that names no manager pid is refused and nothing is connected to',()=>withDir(async dir=>{
  const killed=[];
  const silent=()=>{const child=new EventEmitter();child.stdout=new EventEmitter();child.stdout.setEncoding=()=>{};setImmediate(()=>child.emit('exit',0));return child;};
  const bridge=new LtfBridge({launcher:'x',dll:'x',dataDir:dir,pause:()=>wait(1),
    isRunning:async()=>false,hostRunning:async()=>false,taskkill:async(_exe,args)=>{killed.push(args);},launch:silent});
  await assert.rejects(bridge.ensure(),/did not say which LTK Manager/i);
  assert.equal(bridge.connected,false);
  assert.ok(killed.length>0,'the manager just started is closed');
}));
