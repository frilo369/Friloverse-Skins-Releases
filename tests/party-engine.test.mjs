import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {PartyCoordinator} from '../src/party-coordinator.mjs';
import {SkinEngine} from '../src/engine.mjs';

const sha=letter=>letter.repeat(40);
const friend=(champion='lux',letter='b')=>({source:'custom',championId:champion,relative:'Friend skin',sha:sha(letter)});

/** A real coordinator and a real engine, wired as main.cjs wires them. */
function fixture(dir){
  const f={calls:[],mods:[{id:'own',enabled:true}]};
  let next=0;
  const bridge={
    connected:false,child:null,
    ensure:async()=>{f.calls.push('ensure');},
    status:async()=>({running:false,phase:'idle'}),
    stop:async()=>{},
    patch:async()=>{f.calls.push(`start:${f.mods.filter(mod=>mod.enabled).map(mod=>mod.id).join('+')}`);},
    endPatching:async()=>{f.calls.push('end');},
    readyMod:async()=>'',
    patcherAtStart:async()=>false,
    setPatcherAtStart:async()=>{},
    mods:async()=>f.mods.map(mod=>({...mod})),
    install:async file=>{f.calls.push(`install:${path.basename(file)}`);const mod={id:`staged-${++next}`,enabled:true};f.mods.push(mod);return {kind:'installed',mod};},
    uninstall:async id=>{f.calls.push(`uninstall:${id}`);f.mods=f.mods.filter(mod=>mod.id!==id);},
    toggle:async(id,enabled)=>{f.calls.push(`toggle:${id}:${enabled}`);f.mods.find(mod=>mod.id===id).enabled=enabled;},
    quit:async()=>{f.calls.push('quit');},
    detach:()=>{},
  };
  f.engine=new SkinEngine({bridge,dataDir:dir,noGame:async()=>true,settle:0,pause:async()=>{},buildSlot:async()=>null});
  f.engine.hold={open:false,frozen:false,sealed:true};
  f.party=new PartyCoordinator({dataDir:dir,version:'2.8.0',localPick:()=>null,
    findSkin:async(champion,hash)=>({key:hash,file:`C:/found/${champion}.fantome`,label:'Friend skin',alias:champion,trusted:true}),
    onFiles:files=>f.engine.setParty(files)});
  f.party.client.session={code:'ABCD'};
  f.party.client.state.members=[{id:f.party.client.clientId,host:true,db:''}];
  f.run=async()=>{clearTimeout(f.party.timer);clearTimeout(f.engine.timer);await f.engine.pump();};
  return f;
}
async function withDir(work){
  const dir=await mkdtemp(path.join(tmpdir(),'friloverse-party-engine-'));
  try{await work(dir);}finally{await rm(dir,{recursive:true,force:true});}
}

test('a friend\'s pick is turned into a file here and handed to LTK Manager',()=>withDir(async dir=>{
  const f=fixture(dir);
  try{
    f.engine.observe('ChampSelect');
    f.party.receive([friend()],1);
    await f.party.reconcile();
    assert.equal(f.engine.party.length,1,'the coordinator handed the engine the found skin');
    await f.run();
    assert.ok(f.calls.includes('install:lux.fantome'),'LTK Manager was given the friend\'s skin');
    assert.equal(f.calls.at(-1),'start:staged-1','and it is the skin the patcher starts with');
    assert.equal(f.engine.status,'ready');
    assert.deepEqual(f.engine.journal.staged.map(row=>row.key),[sha('b')]);
  }finally{f.party.dispose();clearTimeout(f.party.timer);clearTimeout(f.engine.timer);}
}));

test('when the friend turns it off, it leaves this PC\'s next plan too',()=>withDir(async dir=>{
  const f=fixture(dir);
  try{
    f.engine.observe('ChampSelect');
    f.party.receive([friend()],1);
    await f.party.reconcile();await f.run();
    f.calls.length=0;
    f.party.receive([],2);
    await f.party.reconcile();
    assert.deepEqual(f.engine.party,[],'the coordinator took the skin back');
    await f.run();
    assert.ok(f.calls.includes('uninstall:staged-1'),'and LTK Manager no longer loads it');
    assert.equal(f.engine.journal.staged.length,0);
  }finally{f.party.dispose();clearTimeout(f.party.timer);clearTimeout(f.engine.timer);}
}));

test('a skin this PC does not have is never installed and is reported',()=>withDir(async dir=>{
  const f=fixture(dir);
  try{
    f.engine.observe('ChampSelect');
    f.party.findSkin=async()=>null;
    f.party.receive([friend('zed','c')],1);
    await f.party.reconcile();
    await f.run();
    assert.ok(!f.calls.some(call=>call.startsWith('install:')),'nothing was installed');
    assert.deepEqual(f.party.snapshot().missing,[{champion:'zed',name:'Friend skin'}]);
  }finally{f.party.dispose();clearTimeout(f.party.timer);clearTimeout(f.engine.timer);}
}));
