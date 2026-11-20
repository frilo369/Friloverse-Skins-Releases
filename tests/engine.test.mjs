import test from 'node:test';
import assert from 'node:assert/strict';
import {access,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {ARM_QUIET,ARM_QUIET_MAX,SkinEngine,plainLtkError} from '../src/engine.mjs';
import {GuideWatcher} from '../src/guide-lcu.mjs';
import {GameHold} from '../src/game-hold.mjs';

const skin=(key,label=key)=>({key:key.padEnd(40,'0'),file:`C:/skins/${key}.fantome`,label});
function fixture(dir,{mods=[{id:'own',enabled:true},{id:'other',enabled:false}]}={}){
  const f={mods:mods.map(mod=>({...mod})),calls:[],phase:'idle',running:false,connected:false,game:false,installOutcome:{},failInstall:new Set(),child:null,asked:[],ensures:[],retries:[]};
  let next=0;
  f.bridge={
    get connected(){return f.connected;},
    get child(){return f.child;},
    get canToggle(){return f.canToggle;},
    ensure:async options=>{f.ensures.push(options?.takeOver===true);if(f.ensureError)throw f.ensureError;f.calls.push('ensure');f.connected=true;f.child={pid:1};},
    patcherAlive:async()=>!f.hostDead,
    status:async()=>({running:f.running,phase:f.phase}),
    stop:async()=>{f.calls.push('stop');f.running=false;f.phase='idle';},
    patch:async()=>{
      f.calls.push(`start:${f.mods.filter(mod=>mod.enabled).map(mod=>mod.id).join('+')}`);
      if(f.stops)throw Object.assign(new Error('LTK Manager did not start its patcher.'),{plain:true});
      f.connected=false;f.child=null;f.patching=true;
    },
    endPatching:async()=>{f.calls.push('end');f.patching=false;},
    readyMod:async(id,options)=>{f.asked.push([id,options.repair]);return f.flagged===id?(f.problem||'skinhack'):'';},
    patcherAtStart:async()=>f.atStart===true,
    setPatcherAtStart:async on=>{f.atStart=on;f.restoredAtStart=on;},
    mods:async()=>f.mods.map(mod=>({...mod})),
    install:async file=>{
      f.calls.push(`install:${path.basename(file)}`);
      if(f.failInstall.has(file))throw Object.assign(new Error('this archive is broken'),{code:'X'});
      if(f.onInstall)await f.onInstall(file);
      const known=f.installOutcome[file];
      if(known)return known;
      const mod={id:`staged-${++next}`,enabled:true};f.mods.push(mod);
      return {kind:'installed',mod};
    },
    uninstall:async id=>{f.calls.push(`uninstall:${id}`);f.mods=f.mods.filter(mod=>mod.id!==id);},
    toggle:async(id,enabled)=>{f.calls.push(`toggle:${id}:${enabled}`);f.mods.find(mod=>mod.id===id).enabled=enabled;},
    quit:async()=>{f.calls.push('quit');f.connected=false;f.child=null;},
    detach:()=>{f.calls.push('detach');f.connected=false;f.child=null;},
  };
  f.slotFails=[];
  f.buildSlot=async({file,champion,slot})=>{if(f.noSlot)return null;return `C:/slots/${path.basename(file,'.fantome')}-${champion}-${slot}.fantome`;};
  f.engine=new SkinEngine({bridge:f.bridge,dataDir:dir,noGame:async()=>!f.game,settle:0,pause:async()=>{},onRetry:message=>f.retries.push(message),buildSlot:(...args)=>f.buildSlot(...args),onSlotFailed:alias=>f.slotFails.push(alias)});
  // Choices are final unless a test says otherwise: most of these are about the patch itself.
  f.engine.hold={open:false,frozen:false,sealed:true};
  f.run=async()=>{clearTimeout(f.engine.timer);await f.engine.pump();};
  return f;
}
async function withDir(work){
  const dir=await mkdtemp(path.join(tmpdir(),'friloverse-engine-'));
  try{await work(dir);}finally{await rm(dir,{recursive:true,force:true});}
}

test('a bridge that cannot toggle leaves the player\'s own mods alone',()=>withDir(async dir=>{
  const f=fixture(dir,{mods:[{id:'own',enabled:true}]});
  f.canToggle=false;
  f.engine.observe('ChampSelect');f.engine.setPersonal(skin('ahri','Ahri'));await f.run();
  assert.ok(f.calls.includes('install:ahri.fantome'));
  assert.ok(!f.calls.some(call=>call.startsWith('toggle:')),'nothing is toggled through a bridge without that command');
  assert.equal(f.engine.journal.userEnabled,null);
  f.engine.setPersonal(null);f.engine.observe('Lobby');await f.run();
  assert.ok(!f.calls.some(call=>call.startsWith('toggle:')),'cleanup does not try to restore what it never switched off');
  assert.equal(f.mods.find(mod=>mod.id==='own').enabled,true);
}));

test('a connected bridge that is patching stays open when the game begins',()=>withDir(async dir=>{
  const f=fixture(dir);
  f.engine.observe('ChampSelect');f.engine.setPersonal(skin('ahri','Ahri'));await f.run();
  assert.equal(f.engine.journal.patching,true,'the draft started the patcher');
  // The bundled LTF bridge keeps one manager connected while its patcher runs.
  f.connected=true;f.child={pid:1};f.game=true;f.calls.length=0;
  f.engine.observe('InProgress');await f.run();
  assert.ok(!f.calls.includes('quit'),'the manager that patches is not closed under the game');
  clearTimeout(f.engine.timer);
}));

test('a connected bridge that is only waiting for a pick is closed when the game begins',()=>withDir(async dir=>{
  const f=fixture(dir);
  f.engine.observe('ChampSelect');await f.run();
  f.connected=true;f.child={pid:1};f.game=true;f.calls.length=0;
  f.engine.observe('InProgress');await f.run();
  assert.deepEqual(f.calls,['quit'],'nothing was patched, so the waiting manager goes');
  clearTimeout(f.engine.timer);
}));

test('a content refusal survives party changes, slot changes and repatching until match cleanup',()=>withDir(async dir=>{
  const f=fixture(dir),pick={...skin('bad','Refused Ahri'),alias:'Ahri'};
  f.flagged='staged-1';f.engine.observe('ChampSelect');f.engine.setPersonal(pick);await f.run();
  const refusal=f.engine.failureFor(pick.key);
  assert.match(refusal,/skin hack/);
  f.engine.setParty([skin('friend')]);await f.run();
  f.engine.setSlots(new Map([['ahri',66]]));await f.run();
  f.engine.setHold({open:true,frozen:true,sealed:true});f.engine.observe('GameStart');
  f.engine.repatch();await f.run();
  assert.equal(f.calls.filter(call=>call==='install:bad.fantome').length,1);
  assert.equal(f.asked.filter(([id])=>id==='staged-1').length,1);
  assert.equal(f.engine.failureFor(pick.key),refusal);
  assert.deepEqual(f.engine.journal.staged.map(row=>row.key),[skin('friend').key]);
  f.engine.setPersonal(null);await f.run();f.engine.setPersonal(pick);await f.run();
  assert.equal(f.calls.filter(call=>call==='install:bad.fantome').length,1,'deselecting does not retry it this match');
  f.engine.setHold({open:false,frozen:false,sealed:false});f.engine.observe('Lobby');await f.run();
  f.engine.observe('ChampSelect');await f.run();
  assert.equal(f.calls.filter(call=>call==='install:bad.fantome').length,2,'a new match checks it again');
  clearTimeout(f.engine.timer);
}));

test('a refused slot copy is not rebuilt on a friend change, while its original stays enabled',()=>withDir(async dir=>{
  const f=fixture(dir),pick={...skin('ahri'),alias:'Ahri'};
  f.flagged='staged-2';f.engine.observe('ChampSelect');f.engine.setPersonal(pick);
  f.engine.setSlots(new Map([['ahri',66]]));await f.run();
  f.engine.setParty([skin('friend')]);await f.run();
  assert.equal(f.calls.filter(call=>call==='install:ahri-Ahri-66.fantome').length,1);
  assert.deepEqual(f.engine.journal.staged.map(row=>row.key),[pick.key,skin('friend').key]);
  assert.match(f.engine.failureFor(pick.key),/could not be applied over the skin selected in League/);
  assert.equal(f.engine.status,'failed');
}));

test('losing the League client for 30 seconds keeps the frozen game and staged skins until a real end phase',()=>withDir(async dir=>{
  const f=fixture(dir);let time=1000,online=true,phase='ChampSelect',closed=0,emit;
  const hold=new GameHold({engine:f.engine,party:{report(){},choosing:()=>[]},now:()=>time,
    start:({onEvent})=>{emit=onEvent;return {send(){},close(){closed++;}};},reconnect:async()=>{},scanStart:async()=>0});
  hold.schedule=()=>{};
  const watcher=new GuideWatcher(sighting=>{hold.observe(sighting.phase);f.engine.observe(sighting.phase);},{
    now:()=>time,readConnection:async()=>{if(!online)throw Error('offline');return {};},
    request:async(_,endpoint)=>endpoint.endsWith('gameflow-phase')?phase:null,
  });
  try{
    await watcher.poll();f.engine.setPersonal(skin('a'));await f.run();
    phase='GameStart';await watcher.poll();emit({event:'suspended',pid:7,created:time});await f.run();
    const staged=structuredClone(f.engine.journal.staged);f.calls.length=0;
    online=false;await watcher.poll();time+=10000;await watcher.poll();time+=20000;await watcher.poll();await f.run();
    assert.equal(watcher.sighting.phase,'GameStart');assert.equal(hold.frozen,true);assert.equal(closed,0);
    assert.deepEqual(f.engine.journal.staged,staged);assert.ok(!f.calls.some(call=>call.startsWith('uninstall:')));
    online=true;phase='Lobby';time+=2000;await watcher.poll();await f.run();
    assert.equal(hold.frozen,false);assert.equal(closed,1);assert.deepEqual(f.engine.journal.staged,[]);
  }finally{watcher.stop();hold.dispose();clearTimeout(f.engine.timer);}
}));

test('a pick is installed, the player\'s other mods go off, and the patcher starts',()=>withDir(async dir=>{
  const f=fixture(dir);
  f.engine.observe('ChampSelect');f.engine.setPersonal(skin('a'));
  await f.run();
  assert.deepEqual(f.calls,['ensure','install:a.fantome','toggle:own:false','start:staged-1']);
  assert.equal(f.engine.status,'ready');
  const journal=JSON.parse(await readFile(path.join(dir,'engine-journal.json'),'utf8'));
  assert.deepEqual(journal.userEnabled,['own'],'the player\'s choice is saved first');
  assert.equal(journal.staged[0].ours,true);
  clearTimeout(f.engine.timer);
}));

test('a handcrafted form is repaired although Riot skins are trusted',()=>withDir(async dir=>{
  const f=fixture(dir);
  f.engine.observe('ChampSelect');
  f.engine.setPersonal({...skin('v'),trusted:true,repair:true});
  await f.run();
  assert.deepEqual(f.asked,[['staged-1',true]],'LTK\'s Repair fixes the form\'s old property types');
  assert.equal(f.engine.status,'ready');
  clearTimeout(f.engine.timer);
}));

test('an ordinary trusted Riot skin skips LTK repair',()=>withDir(async dir=>{
  const f=fixture(dir);
  f.engine.observe('ChampSelect');
  f.engine.setPersonal({...skin('a'),trusted:true});
  await f.run();
  assert.deepEqual(f.asked,[]);
  assert.equal(f.engine.status,'ready');
  clearTimeout(f.engine.timer);
}));

test('a prepared custom skin loads its finished archive without match-time checking or Repair',()=>withDir(async dir=>{
  const f=fixture(dir),pick={...skin('prepared'),alias:'Ahri'};
  f.engine.prepareFile=async requested=>({...requested,file:'C:/prepared/yumeko.fantome',prepared:true});
  f.flagged='staged-1';
  f.engine.observe('ChampSelect');f.engine.setPersonal(pick);await f.run();
  assert.ok(f.calls.includes('install:yumeko.fantome'));
  assert.ok(!f.calls.includes('install:prepared.fantome'));
  assert.deepEqual(f.asked,[],'the finished archive was already checked by the batch preparer');
  assert.equal(f.engine.status,'ready');assert.equal(f.engine.journal.staged[0].key,pick.key);
}));

test('a selected-slot copy is built from the prepared archive, with the same transport key',()=>withDir(async dir=>{
  const f=fixture(dir),pick={...skin('prepared'),alias:'Ahri'},built=[];
  f.engine.prepareFile=async requested=>({...requested,file:'C:/prepared/yumeko.fantome',prepared:true});
  f.buildSlot=async request=>{built.push(request);return 'C:/slots/yumeko-66.fantome';};
  f.engine.setSlots(new Map([['ahri',66]]));f.engine.observe('ChampSelect');f.engine.setPersonal(pick);await f.run();
  assert.equal(built.length,1);assert.equal(built[0].file,'C:/prepared/yumeko.fantome');
  assert.deepEqual(f.asked,[]);assert.equal(f.engine.status,'ready');
  assert.deepEqual(f.engine.journal.staged.map(row=>row.key),[pick.key,`${pick.key}@66`]);
}));

test('an unprepared skin is reported before installation and never gets a slot copy',()=>withDir(async dir=>{
  const f=fixture(dir),pick={...skin('unprepared'),alias:'Ahri'};let built=0;
  f.engine.prepareFile=async()=>{throw Object.assign(new Error('Custom skins need to be prepared.'),{plain:true});};
  f.buildSlot=async()=>{built++;return 'must-not-be-built.fantome';};
  f.engine.setSlots(new Map([['ahri',66]]));f.engine.observe('ChampSelect');f.engine.setPersonal(pick);await f.run();
  assert.equal(f.engine.status,'failed');assert.match(f.engine.failureFor(pick.key),/need to be prepared/);
  assert.equal(f.engine.journal.staged.length,0);assert.equal(built,0);
  assert.ok(!f.calls.some(call=>call.startsWith('install:')));
}));

test('trusted Riot skins do not query the prepared custom library',()=>withDir(async dir=>{
  const f=fixture(dir);
  f.engine.prepareFile=async()=>{throw new Error('must not query prepared custom skins');};
  f.engine.observe('ChampSelect');f.engine.setPersonal({...skin('riot'),trusted:true});await f.run();
  assert.equal(f.engine.status,'ready');assert.ok(f.calls.includes('install:riot.fantome'));
}));

test('the player coming back gets a new pick with a fresh patch, and no pick needs no LTK',()=>withDir(async dir=>{
  const f=fixture(dir);
  f.engine.observe('ChampSelect');
  f.engine.setPersonal(skin('first'));await f.run();
  f.engine.observe('InProgress');f.game=true;await f.run();
  f.game=false;
  f.engine.observe('Reconnect');f.engine.setHold({open:true,frozen:false,sealed:true});
  f.calls.length=0;
  f.engine.repatch();
  assert.equal(f.engine.settled,false,'a game coming back now would wait');
  await f.run();
  assert.deepEqual(f.calls.filter(call=>/^(end|install|uninstall|start)/.test(call)).map(call=>call.split(':')[0]),['end','start'],'the same skin is only patched again');
  assert.equal(f.engine.settled,true);
  f.calls.length=0;
  f.engine.setPersonal(skin('second'));await f.run();
  assert.ok(f.calls.includes('install:second.fantome'));
  assert.ok(f.calls.some(call=>call.startsWith('start:')));
  clearTimeout(f.engine.timer);
}));

test('nothing was loaded for the match: coming back has nothing to patch',()=>withDir(async dir=>{
  const f=fixture(dir);
  f.engine.observe('Reconnect');
  f.engine.repatch();
  assert.equal(f.engine.applied,'');
  clearTimeout(f.engine.timer);
}));

test('the same plan does nothing twice, and a new pick replaces the old one',()=>withDir(async dir=>{
  const f=fixture(dir);
  f.engine.observe('ChampSelect');f.engine.setPersonal(skin('a'));await f.run();
  f.calls.length=0;await f.run();
  assert.deepEqual(f.calls,[]);
  f.engine.setPersonal(skin('b'));await f.run();
  assert.deepEqual(f.calls,['end','ensure','uninstall:staged-1','install:b.fantome','start:staged-2'],'the patching LTK Manager must close before the library changes');
}));

test('turning off the only skin leaves nothing loading',()=>withDir(async dir=>{
  const f=fixture(dir);
  f.engine.observe('ChampSelect');f.engine.setPersonal(skin('a'));await f.run();
  f.calls.length=0;f.engine.setPersonal(null);await f.run();
  assert.deepEqual(f.calls,['end','ensure','uninstall:staged-1'],'it stays open for the next pick');
  assert.equal(f.patching,false);assert.equal(f.engine.status,'idle');
}));

test('a draft opens LTK Manager before any pick, and a game without one closes it',()=>withDir(async dir=>{
  const f=fixture(dir);
  f.engine.observe('ChampSelect');await f.run();
  assert.deepEqual(f.calls,['ensure']);
  assert.equal(f.engine.status,'idle');
  f.calls.length=0;await f.run();
  assert.deepEqual(f.calls,[],'it is opened once');
  f.engine.observe('GameStart');await f.run();
  assert.deepEqual(f.calls,['quit']);
  assert.equal(f.engine.status,'idle');
}));

test('a game that begins straight after the draft also closes a waiting LTK Manager',()=>withDir(async dir=>{
  const f=fixture(dir);
  f.engine.observe('ChampSelect');await f.run();
  f.calls.length=0;f.engine.observe('InProgress');await f.run();
  assert.deepEqual(f.calls,['quit']);
}));

test('nothing but a draft opens LTK Manager early, and the player\'s setting comes back',()=>withDir(async dir=>{
  const f=fixture(dir);f.atStart=true;
  f.engine.observe('Lobby');await f.run();
  assert.deepEqual(f.calls,[]);
  f.engine.observe('ChampSelect');await f.run();
  f.engine.observe('Lobby');await f.run();
  assert.equal(f.restoredAtStart,true);
  assert.equal(f.connected,false);
  assert.equal(f.engine.journal.alwaysStart,undefined,'read again next time');
}));

test('an LTK Manager the player opened does not stop a draft, and a pick then explains it',()=>withDir(async dir=>{
  const f=fixture(dir);f.ensureError=Object.assign(new Error('LTK Manager is already open.'),{plain:true});
  f.engine.observe('ChampSelect');await f.run();
  assert.equal(f.engine.error,'');assert.equal(f.engine.status,'idle');
  f.engine.setPersonal(skin('a'));await f.run();
  assert.match(f.engine.error,/already open/);
  clearTimeout(f.engine.timer);
}));

test('no LTK Manager is opened while a game is running',()=>withDir(async dir=>{
  const f=fixture(dir);f.game=true;
  f.engine.observe('ChampSelect');await f.run();
  assert.deepEqual(f.calls,[]);
}));

test('Rose\'s list goes straight in; other skins get LTK\'s health check and Repair every time',()=>withDir(async dir=>{
  const f=fixture(dir);
  f.engine.observe('ChampSelect');f.engine.setPersonal({...skin('riot'),trusted:true});await f.run();
  assert.deepEqual(f.asked,[]);
  f.engine.setPersonal(skin('custom'));await f.run();
  assert.deepEqual(f.asked,[['staged-2',true]]);
  assert.equal(f.engine.status,'ready');
  f.engine.setPersonal({...skin('riot'),trusted:true});await f.run();
  f.engine.setPersonal(skin('custom'));await f.run();
  assert.equal(f.asked.length,2,'a new install is a new copy, so it needs its own Repair');
  clearTimeout(f.engine.timer);
}));

test('a mod the player already had is checked but never repaired',()=>withDir(async dir=>{
  const f=fixture(dir);
  f.installOutcome['C:/skins/mine.fantome']={kind:'updated',mod:{id:'own'}};
  f.engine.observe('ChampSelect');f.engine.setPersonal(skin('mine'));await f.run();
  assert.deepEqual(f.asked,[['own',false]]);
  clearTimeout(f.engine.timer);
}));

test('a skin LTK cannot repair stays out, and the player is told in plain words',()=>withDir(async dir=>{
  const f=fixture(dir);f.flagged='staged-1';f.problem='damaged';
  f.engine.observe('ChampSelect');f.engine.setPersonal(skin('old','Old Skin'));await f.run();
  assert.ok(f.calls.includes('uninstall:staged-1'));
  assert.ok(!f.calls.some(call=>call.startsWith('start')));
  assert.match(f.engine.error,/could not repair Old Skin/);
  clearTimeout(f.engine.timer);
}));

test('skins, party skins and mods load together, once each',()=>withDir(async dir=>{
  const f=fixture(dir);
  f.engine.observe('ChampSelect');
  f.engine.setPersonal(skin('a'));f.engine.setParty([skin('b'),skin('a')]);f.engine.setMods([skin('c')]);
  await f.run();
  assert.deepEqual(f.calls.filter(call=>call.startsWith('install')),['install:a.fantome','install:b.fantome','install:c.fantome']);
  assert.equal(f.calls.at(-1),'start:staged-1+staged-2+staged-3');
}));

test('a change made during installing restarts the plan and never starts the old one',()=>withDir(async dir=>{
  const f=fixture(dir);let once=true;
  f.onInstall=async()=>{if(once){once=false;f.engine.setPersonal(skin('b'));clearTimeout(f.engine.timer);}};
  f.engine.observe('ChampSelect');f.engine.setPersonal(skin('a'));
  await f.run();
  assert.deepEqual(f.calls.filter(call=>call.startsWith('start')),['start:staged-2']);
  assert.deepEqual(f.mods.filter(mod=>mod.enabled).map(mod=>mod.id),['staged-2']);
}));

test('a running game is never changed, and the player is told',()=>withDir(async dir=>{
  const f=fixture(dir);
  f.game=true;f.engine.observe('GameStart');f.engine.setPersonal(skin('a'));
  await f.run();
  assert.deepEqual(f.calls,[]);
  assert.match(f.engine.error,/next match/);
  assert.equal(f.engine.status,'failed');assert.equal(f.engine.retryAt,0);assert.equal(f.engine.settled,true);
  f.engine.observe('GameStart');assert.equal(f.engine.waiting,false,'unchanged GameStart does not schedule another attempt');
  clearTimeout(f.engine.timer);
}));

test('everything is undone after the game, and only once the game has closed',()=>withDir(async dir=>{
  const f=fixture(dir);
  f.engine.observe('ChampSelect');f.engine.setPersonal(skin('a'));await f.run();
  f.game=true;f.calls.length=0;
  f.engine.observe('InProgress');await f.run();
  assert.deepEqual(f.calls,[],'the patcher stays for the game');
  f.engine.observe('EndOfGame');await f.run();
  assert.deepEqual(f.calls,[],'the game is still open');
  f.game=false;await f.run();
  assert.deepEqual(f.calls,['end','ensure','uninstall:staged-1','toggle:own:true','quit']);
  assert.deepEqual(f.mods,[{id:'own',enabled:true},{id:'other',enabled:false}]);
  assert.equal(JSON.parse(await readFile(path.join(dir,'engine-journal.json'),'utf8')).userEnabled,null);
}));

test('a dodge undoes it too',()=>withDir(async dir=>{
  const f=fixture(dir);
  f.engine.observe('ChampSelect');f.engine.setPersonal(skin('a'));await f.run();
  f.engine.observe('Lobby');await f.run();
  assert.equal(f.calls.at(-1),'quit');
  assert.deepEqual(f.mods.map(mod=>mod.id),['own','other']);
}));

test('a mod the player already had stays in their library',()=>withDir(async dir=>{
  const f=fixture(dir);
  f.installOutcome['C:/skins/a.fantome']={kind:'alreadyInstalled',mod:{id:'other'}};
  f.engine.observe('ChampSelect');f.engine.setPersonal(skin('a'));await f.run();
  assert.equal(f.mods.find(mod=>mod.id==='other').enabled,true);
  f.engine.observe('Lobby');await f.run();
  assert.deepEqual(f.mods,[{id:'own',enabled:true},{id:'other',enabled:false}]);
}));

test('a crash is undone at the next start, and only when no game is running',()=>withDir(async dir=>{
  const f=fixture(dir);
  f.engine.observe('ChampSelect');f.engine.setPersonal(skin('a'));await f.run();
  clearTimeout(f.engine.timer);
  const again=fixture(dir);again.mods=f.mods;
  await again.engine.load();
  assert.equal(again.engine.pendingRestore,true);
  again.game=true;again.engine.phase='None';await again.run();
  assert.deepEqual(again.calls,[]);
  again.game=false;await again.run();
  assert.deepEqual(again.mods,[{id:'own',enabled:true},{id:'other',enabled:false}]);
  assert.equal(again.engine.pendingRestore,false);
  clearTimeout(again.engine.timer);
}));

const journalOn=async dir=>JSON.parse(await readFile(path.join(dir,'engine-journal.json'),'utf8'));

test('the library is written down before each install and forgotten after it',()=>withDir(async dir=>{
  const f=fixture(dir);let during;
  f.onInstall=async()=>{during=await journalOn(dir);};
  f.engine.observe('ChampSelect');f.engine.setPersonal(skin('a'));await f.run();
  clearTimeout(f.engine.timer);
  assert.deepEqual(during.installing,['own','other']);
  assert.equal((await journalOn(dir)).installing,undefined);
}));

test('a skin LTK installed just before a crash is removed at the next start',()=>withDir(async dir=>{
  await writeFile(path.join(dir,'engine-journal.json'),JSON.stringify({staged:[],userEnabled:['own'],installing:['own','other']}));
  const f=fixture(dir,{mods:[{id:'own',enabled:false},{id:'other',enabled:false},{id:'stray',enabled:true}]});
  await f.engine.load();clearTimeout(f.engine.timer);
  f.engine.observe('Lobby');await f.run();clearTimeout(f.engine.timer);
  assert.ok(f.calls.includes('uninstall:stray'));
  assert.deepEqual(f.mods,[{id:'own',enabled:true},{id:'other',enabled:false}]);
  assert.equal((await journalOn(dir)).installing,undefined);
}));

test('a crash in the middle of a draft is cleared before the next install is written down',()=>withDir(async dir=>{
  await writeFile(path.join(dir,'engine-journal.json'),JSON.stringify({staged:[],userEnabled:['own'],installing:['own','other']}));
  const f=fixture(dir,{mods:[{id:'own',enabled:false},{id:'other',enabled:false},{id:'stray',enabled:true}]});
  await f.engine.load();clearTimeout(f.engine.timer);
  f.engine.observe('ChampSelect');f.engine.setPersonal(skin('a'));await f.run();clearTimeout(f.engine.timer);
  assert.ok(f.calls.indexOf('uninstall:stray')<f.calls.indexOf('install:a.fantome'));
  assert.deepEqual(f.mods.map(mod=>mod.id),['own','other','staged-1']);
}));

test('two unknown mods are left alone, as one of them must be the player\'s',()=>withDir(async dir=>{
  await writeFile(path.join(dir,'engine-journal.json'),JSON.stringify({staged:[],userEnabled:['own'],installing:['own']}));
  const f=fixture(dir,{mods:[{id:'own',enabled:false},{id:'one',enabled:false},{id:'two',enabled:false}]});
  await f.engine.load();clearTimeout(f.engine.timer);
  f.engine.observe('Lobby');await f.run();clearTimeout(f.engine.timer);
  assert.ok(!f.calls.some(call=>call.startsWith('uninstall')));
  assert.equal(f.mods.length,3);
}));

test('a failed install leaves nothing written down',()=>withDir(async dir=>{
  const f=fixture(dir);f.failInstall.add('C:/skins/a.fantome');
  f.engine.observe('ChampSelect');f.engine.setPersonal(skin('a'));await f.run();clearTimeout(f.engine.timer);
  assert.equal((await journalOn(dir)).installing,undefined);
}));

test('a skin LTK installed although its reply was lost is removed at once, never left behind',()=>withDir(async dir=>{
  const f=fixture(dir);
  f.onInstall=async()=>{f.mods.push({id:'lost',enabled:true});throw Object.assign(new Error('the connection to LTK Manager broke'),{code:'X'});};
  f.engine.observe('ChampSelect');f.engine.setPersonal(skin('a'));await f.run();clearTimeout(f.engine.timer);
  assert.ok(f.calls.includes('uninstall:lost'));
  assert.deepEqual(f.mods.map(mod=>mod.id),['own','other']);
  assert.equal((await journalOn(dir)).installing,undefined);
}));

test('a lost install reply with LTK unable to list its library keeps the record for the next look',()=>withDir(async dir=>{
  const f=fixture(dir),list=f.bridge.mods;
  f.onInstall=async()=>{
    f.mods.push({id:'lost',enabled:true});
    f.bridge.mods=async()=>{throw new Error('LTK Manager did not answer');};
    throw Object.assign(new Error('the connection to LTK Manager broke'),{code:'X'});
  };
  f.engine.observe('ChampSelect');f.engine.setPersonal(skin('a'));await f.run();clearTimeout(f.engine.timer);
  assert.deepEqual((await journalOn(dir)).installing,['own','other']);
  // LTK answers again: the match's clean-up finds the newcomer.
  f.bridge.mods=list;f.onInstall=null;
  f.engine.observe('Lobby');await f.run();clearTimeout(f.engine.timer);
  assert.ok(f.calls.includes('uninstall:lost'));
  assert.ok(!f.mods.some(mod=>mod.id==='lost'));
}));

test('the patcher setting survives a crash during the clean-up',()=>withDir(async dir=>{
  const f=fixture(dir);f.atStart=true;let atQuit;
  f.engine.observe('ChampSelect');f.engine.setPersonal(skin('a'));await f.run();clearTimeout(f.engine.timer);
  const quit=f.bridge.quit;f.bridge.quit=async()=>{atQuit=await journalOn(dir);return quit();};
  f.atStart=false;
  f.engine.observe('Lobby');await f.run();clearTimeout(f.engine.timer);
  assert.equal(atQuit.alwaysStart,true,'still known while LTK Manager is closing');
  assert.equal(f.restoredAtStart,true);
  assert.equal((await journalOn(dir)).alwaysStart,undefined,'forgotten only once put back');
}));

test('a journal holding only the patcher setting is finished at the next start',()=>withDir(async dir=>{
  await writeFile(path.join(dir,'engine-journal.json'),JSON.stringify({staged:[],userEnabled:null,alwaysStart:true}));
  const f=fixture(dir);
  await f.engine.load();clearTimeout(f.engine.timer);
  assert.ok(f.engine.timer!==null,'it does not wait for League to be seen');
  await f.run();clearTimeout(f.engine.timer);
  assert.equal(f.restoredAtStart,true);
}));

test('a damaged journal is ignored rather than acted on',()=>withDir(async dir=>{
  const {writeFile}=await import('node:fs/promises');
  await writeFile(path.join(dir,'engine-journal.json'),JSON.stringify({staged:[{modId:5}],userEnabled:'x'}));
  const f=fixture(dir);await f.engine.load();
  assert.equal(f.engine.pendingRestore,false);
}));

test('one bad archive does not stop the others, and is reported',()=>withDir(async dir=>{
  const f=fixture(dir);
  f.failInstall.add('C:/skins/a.fantome');
  f.engine.observe('ChampSelect');f.engine.setPersonal(skin('a'));f.engine.setMods([skin('b')]);
  await f.run();
  assert.equal(f.calls.at(-1),'start:staged-1');
  assert.equal(f.engine.status,'failed');
  assert.match(f.engine.error,/broken/);
  assert.match(f.engine.failureFor(skin('a').key),/broken/);
}));

test('a patcher that stops by itself is an error, not a silent no-skin match',()=>withDir(async dir=>{
  const f=fixture(dir);f.stops=true;
  f.engine.observe('ChampSelect');f.engine.setPersonal(skin('a'));
  await f.run();
  assert.equal(f.engine.status,'failed');assert.match(f.engine.error,/did not start its patcher/);
  clearTimeout(f.engine.timer);
}));

test('a skin LTK flags stays out, so the rest of the match still loads, and the player is told',()=>withDir(async dir=>{
  const f=fixture(dir);f.flagged='staged-1';
  f.engine.observe('ChampSelect');f.engine.setPersonal(skin('bad','Bellion'));f.engine.setParty([skin('good')]);
  await f.run();
  assert.ok(f.calls.includes('uninstall:staged-1'));
  assert.equal(f.calls.at(-1),'start:staged-2');
  assert.deepEqual(f.engine.journal.staged.map(row=>row.modId),['staged-2']);
  assert.equal(f.engine.status,'failed');
  assert.match(f.engine.error,/Bellion as a skin hack/);
  assert.match(f.engine.failureFor(skin('bad').key),/skin hack/);
}));

test('a flagged skin alone starts no patcher',()=>withDir(async dir=>{
  const f=fixture(dir);f.flagged='staged-1';
  f.engine.observe('ChampSelect');f.engine.setPersonal(skin('bad','Bellion'));
  await f.run();
  assert.ok(!f.calls.some(call=>call.startsWith('start')));
  assert.equal(f.engine.status,'failed');assert.match(f.engine.error,/skin hack/);
}));

test('the player\'s own patcher setting comes back after the match',()=>withDir(async dir=>{
  const f=fixture(dir);f.atStart=true;
  f.engine.observe('ChampSelect');f.engine.setPersonal(skin('a'));await f.run();
  assert.equal(f.engine.journal.alwaysStart,true);
  assert.equal(f.engine.journal.patching,true,'written down before it starts, so a crash can undo it');
  f.engine.observe('Lobby');await f.run();
  assert.equal(f.restoredAtStart,true);
  assert.ok(f.calls.indexOf('end')<f.calls.indexOf('ensure',f.calls.indexOf('end')),'the patching one closes first');
}));

test('after a crash the LTK Manager still patching is closed before anything is undone',()=>withDir(async dir=>{
  const first=fixture(dir);
  first.engine.observe('ChampSelect');first.engine.setPersonal(skin('a'));await first.run();
  const f=fixture(dir);f.mods=first.mods;
  await f.engine.load();clearTimeout(f.engine.timer);
  f.engine.observe('Lobby');await f.run();
  assert.deepEqual(f.calls.slice(0,2),['end','ensure']);
  assert.equal(f.engine.pendingRestore,false);
}));

test('an LTK Manager the player opened themselves is explained and retried',()=>withDir(async dir=>{
  const f=fixture(dir);
  f.ensureError=Object.assign(new Error('LTK Manager is already open. Close it.'),{plain:true});
  f.engine.observe('ChampSelect');f.engine.setPersonal(skin('a'));
  await f.run();
  assert.match(f.engine.error,/already open/);
  assert.ok(f.engine.retryAt>0);
  clearTimeout(f.engine.timer);
}));

test('quitting never disturbs a running game',()=>withDir(async dir=>{
  const f=fixture(dir);
  f.engine.observe('ChampSelect');f.engine.setPersonal(skin('a'));await f.run();
  f.game=true;f.calls.length=0;
  await f.engine.shutdown();
  assert.deepEqual(f.calls,['detach']);
  assert.equal(f.engine.pendingRestore,true,'kept for the next start');
}));

test('quitting between matches undoes everything',()=>withDir(async dir=>{
  const f=fixture(dir);
  f.engine.observe('ChampSelect');f.engine.setPersonal(skin('a'));await f.run();
  await f.engine.shutdown();
  assert.equal(f.engine.pendingRestore,false);
  assert.equal(f.calls.at(-1),'quit');
}));

test('LTK Manager\'s error codes become plain words',()=>{
  assert.match(plainLtkError({code:'LEAGUE_ELEVATED',message:'x'}),/administrator/);
  assert.equal(plainLtkError({plain:true,message:'Close it.'}),'Close it.');
  assert.match(plainLtkError(new Error('boom')),/^LTK Manager: boom/);
});

test('a late skin goes in under a frozen game, and never under a running one',()=>withDir(async dir=>{
  const f=fixture(dir);
  f.engine.observe('GameStart');f.game=true;
  f.engine.setHold({open:true,frozen:false,sealed:true});
  f.engine.setPersonal(skin('late','Late'));await f.run();
  assert.ok(!f.calls.some(call=>call.startsWith('install')),'a game not frozen is never changed');
  assert.match(f.engine.error,/applies from the next match/);
  assert.equal(f.engine.settled,true);
  f.engine.setHold({open:true,frozen:true,sealed:true});await f.run();
  assert.ok(f.calls.some(call=>call.startsWith('install')));
  assert.equal(f.engine.status,'ready');
  assert.equal(f.engine.settled,true);
  assert.equal(f.engine.overlayOn,true);
  assert.ok(f.engine.patchedAt>=f.engine.patchAt&&f.engine.patchAt>0);
  clearTimeout(f.engine.timer);
}));

test('a game that gets frozen a moment later still takes the skin',()=>withDir(async dir=>{
  const f=fixture(dir);
  f.engine.observe('GameStart');f.game=true;
  f.engine.pause=async()=>{f.engine.hold={open:true,frozen:true,sealed:true};};
  f.engine.hold={open:true,frozen:false,sealed:true};
  f.engine.setPersonal(skin('late','Late'));await f.run();
  assert.ok(f.calls.some(call=>call.startsWith('install')));
  clearTimeout(f.engine.timer);
}));

test('while the hold is open an LTK waiting for a late pick is kept; afterwards it closes',()=>withDir(async dir=>{
  const f=fixture(dir);
  f.engine.observe('ChampSelect');await f.run();
  assert.equal(f.bridge.connected,true);
  f.engine.setHold({open:true,frozen:false});f.engine.observe('GameStart');await f.run();
  assert.equal(f.bridge.connected,true);
  f.engine.setHold({open:false,frozen:false});await f.run();
  assert.equal(f.bridge.connected,false);
  clearTimeout(f.engine.timer);
}));

test('settled is false until a change has been dealt with',()=>withDir(async dir=>{
  const f=fixture(dir);
  f.engine.observe('ChampSelect');await f.run();
  assert.equal(f.engine.settled,true);
  f.engine.setPersonal(skin('one'));
  assert.equal(f.engine.settled,false);
  await f.run();
  assert.equal(f.engine.settled,true);
  clearTimeout(f.engine.timer);
}));

const starts=f=>f.calls.filter(call=>call.startsWith('start')).length;
const openDraft=f=>{f.engine.hold={open:false,frozen:false,sealed:false};f.engine.observe('ChampSelect');};

test('during a draft a skin is installed and checked, but the patcher waits',()=>withDir(async dir=>{
  const f=fixture(dir);openDraft(f);
  f.engine.setPersonal(skin('a'));await f.run();
  assert.deepEqual(f.calls,['ensure','install:a.fantome','toggle:own:false']);
  assert.deepEqual(f.asked,[['staged-1',true]],'LTK has already said whether it can load');
  assert.equal(f.engine.status,'ready');
  assert.equal(f.engine.settled,true);
  assert.equal(f.engine.overlayOn,false);
  clearTimeout(f.engine.timer);
}));

test('every change of a draft goes in together, with one patcher start when the choices are final',()=>withDir(async dir=>{
  const f=fixture(dir);openDraft(f);
  f.engine.setPersonal(skin('a'));await f.run();
  f.engine.setPersonal(skin('b'));await f.run();
  f.engine.setParty([skin('c')]);await f.run();
  f.engine.setMods([skin('d')]);await f.run();
  assert.equal(starts(f),0);
  assert.ok(!f.calls.includes('end'),'nothing was running to close');
  f.engine.setHold({open:true,frozen:true,sealed:true});
  assert.equal(f.engine.settled,false,'League must not go before the patch');
  await f.run();
  assert.equal(starts(f),1);
  assert.equal(f.calls.at(-1),'start:staged-2+staged-3+staged-4');
  assert.equal(f.engine.settled,true);
  assert.equal(f.engine.overlayOn,true);
  clearTimeout(f.engine.timer);
}));

test('the grace period queues too, and the same queue is not worked through twice',()=>withDir(async dir=>{
  const f=fixture(dir);openDraft(f);
  f.engine.setPersonal(skin('a'));await f.run();
  f.engine.observe('GameStart');f.engine.setHold({open:true,frozen:true,sealed:false});await f.run();
  f.calls.length=0;await f.run();
  assert.deepEqual(f.calls,[]);
  f.engine.setPersonal(skin('late'));await f.run();
  assert.deepEqual(f.calls,['ensure','uninstall:staged-1','install:late.fantome']);
  assert.equal(starts(f),0);
  f.engine.setHold({open:true,frozen:true,sealed:true});await f.run();
  assert.equal(starts(f),1);
  clearTimeout(f.engine.timer);
}));

// The quiet time is a real timer: these wait for what it does, however long the machine takes.
const until=async done=>{for(let i=0;i<1000&&!done();i++)await new Promise(next=>setTimeout(next,5));assert.ok(done(),'the quiet time never ran out');};
const untilStarts=(f,count)=>until(()=>starts(f)>=count&&!f.engine.busy);

test('the quiet time before the patcher starts in a draft is three seconds',()=>{assert.equal(ARM_QUIET,3000);});

test('a pick that has stood still gets its patcher during the draft, and stays ready meanwhile',()=>withDir(async dir=>{
  const f=fixture(dir),seen=[];openDraft(f);f.engine.arm=1;
  f.engine.setPersonal(skin('a'));await f.run();
  assert.equal(starts(f),0,'not before it has stood still');
  assert.equal(f.engine.settled,true,'nothing is pending while it stands');
  f.engine.onChange=()=>seen.push(f.engine.status);
  await untilStarts(f,1);
  assert.equal(f.calls.at(-1),'start:staged-1');
  assert.equal(f.engine.overlayOn,true);
  assert.equal(f.engine.settled,true);
  assert.ok(f.engine.patchedAt>=f.engine.patchAt&&f.engine.patchAt>0,'the hold compares LTK\'s scan with these');
  assert.ok(seen.length&&seen.every(status=>status==='ready'),'the pick was in all along');
  // Choices closing finds everything in place: no second start, and nothing is closed.
  f.engine.observe('GameStart');f.engine.setHold({open:true,frozen:true,sealed:true});await f.run();
  assert.equal(starts(f),1);
  assert.ok(!f.calls.includes('end'));
  assert.equal(f.engine.settled,true);
  clearTimeout(f.engine.timer);
}));

test('a change after the patcher started takes it down, queues the new pick and arms again',()=>withDir(async dir=>{
  const f=fixture(dir);openDraft(f);f.engine.arm=1;
  f.engine.setPersonal(skin('a'));await f.run();await untilStarts(f,1);
  f.engine.arm=60000;f.calls.length=0;
  f.engine.setPersonal(skin('b'));await f.run();
  assert.deepEqual(f.calls,['end','ensure','uninstall:staged-1','install:b.fantome']);
  assert.equal(f.engine.overlayOn,false);
  assert.equal(f.engine.status,'ready');
  assert.equal(f.engine.settled,true);
  // Back to the first pick: its patcher is gone, so it must not be taken for applied.
  f.engine.arm=1;
  f.engine.setPersonal(skin('a'));await f.run();
  assert.equal(f.calls.at(-1),'install:a.fantome');
  await untilStarts(f,1);
  assert.equal(f.calls.at(-1),'start:staged-3');
  assert.equal(f.engine.overlayOn,true);
  clearTimeout(f.engine.timer);
}));

test('going back to the first pick while the change is going in does not count it as still patched',()=>withDir(async dir=>{
  const f=fixture(dir);openDraft(f);f.engine.arm=1;
  f.engine.setPersonal(skin('a'));await f.run();await untilStarts(f,1);
  f.onInstall=async()=>{f.onInstall=null;f.engine.setPersonal(skin('a'));};
  f.engine.setPersonal(skin('b'));await f.run();await untilStarts(f,2);
  assert.deepEqual(f.engine.journal.staged.map(row=>row.key),[skin('a').key]);
  assert.equal(f.calls.at(-1),'start:staged-3');
  assert.equal(f.engine.overlayOn,true);
  assert.equal(f.engine.settled,true);
  clearTimeout(f.engine.timer);
}));

test('choices closing before the pick has stood still patch at once, and only once',()=>withDir(async dir=>{
  const f=fixture(dir);openDraft(f);f.engine.arm=30;
  f.engine.setPersonal(skin('a'));await f.run();
  assert.ok(f.engine.armTimer);
  f.engine.observe('GameStart');f.engine.setHold({open:true,frozen:true,sealed:true});await f.run();
  assert.equal(starts(f),1);
  assert.equal(f.engine.armTimer,null,'nothing is left to fire');
  await new Promise(done=>setTimeout(done,80));
  assert.equal(starts(f),1);
  clearTimeout(f.engine.timer);
}));

test('a change inside the quiet time starts it again',()=>withDir(async dir=>{
  const f=fixture(dir);openDraft(f);
  f.engine.setPersonal(skin('a'));await f.run();
  const first=f.engine.armTimer;assert.ok(first);
  f.engine.setPersonal(skin('b'));await f.run();
  assert.ok(f.engine.armTimer&&f.engine.armTimer!==first,'a quiet time of its own');
  assert.equal(starts(f),0);
  // The same pick again is not a change, and gets no new wait.
  const second=f.engine.armTimer;
  f.engine.setPersonal(skin('b'));await f.run();
  assert.equal(f.engine.armTimer,second);
  clearTimeout(f.engine.timer);clearTimeout(f.engine.armTimer);
}));

test('the early patcher waits for the last game to close, without a word to the player',()=>withDir(async dir=>{
  const f=fixture(dir);openDraft(f);f.engine.arm=1;
  f.engine.setPersonal(skin('a'));await f.run();
  f.game=true;
  await until(()=>f.engine.armFor&&f.engine.retryAt&&!f.engine.busy);
  assert.equal(starts(f),0,'never under a running game');
  assert.equal(f.engine.status,'ready');
  assert.equal(f.engine.error,'');
  f.game=false;f.engine.retryAt=1;f.engine.observe('ChampSelect');await f.run();
  assert.equal(starts(f),1);
  clearTimeout(f.engine.timer);
}));

test('a dodge after the patcher started in the draft undoes it like any match',()=>withDir(async dir=>{
  const f=fixture(dir);openDraft(f);f.engine.arm=1;
  f.engine.setPersonal(skin('a'));await f.run();await untilStarts(f,1);
  f.engine.setPersonal(null);f.engine.observe('Lobby');await f.run();
  assert.ok(f.calls.includes('end'),'the patching LTK Manager is closed');
  assert.equal(f.engine.overlayOn,false);
  assert.deepEqual(f.engine.journal.staged,[]);
  assert.deepEqual(f.mods,[{id:'own',enabled:true},{id:'other',enabled:false}],'the player\'s own mods are back as they were');
  assert.equal(f.engine.armFor,'');
  clearTimeout(f.engine.timer);
}));

test('a change while the patcher is starting gives that start up instead of waiting for it',()=>withDir(async dir=>{
  const f=fixture(dir),real=f.bridge.patch;let asked=0;
  f.bridge.patch=async options=>{
    await real();
    // The first start is still building its overlay when a friend's skin arrives.
    if(!asked++){assert.equal(options.stale(),false);f.engine.setParty([skin('friend')]);return options.stale()?false:true;}
    return true;
  };
  f.engine.observe('ChampSelect');f.engine.setPersonal(skin('a'));await f.run();
  assert.deepEqual(f.calls,['ensure','install:a.fantome','toggle:own:false','start:staged-1','end','ensure','install:friend.fantome','start:staged-1+staged-2']);
  assert.equal(f.engine.applied,f.engine.signature());
  assert.equal(f.engine.settled,true);
  assert.equal(f.engine.status,'ready');
  clearTimeout(f.engine.timer);
}));

test('a patcher that dies in the draft is started again for the same skins, without counting as a change',()=>withDir(async dir=>{
  const f=fixture(dir);openDraft(f);f.engine.arm=1;
  f.engine.setPersonal(skin('a'));await f.run();await untilStarts(f,1);
  f.hostDead=true;
  assert.equal(await f.engine.checkPatcher({now:true}),true);
  f.hostDead=false;await f.run();
  assert.equal(starts(f),2);
  assert.equal(f.engine.overlayOn,true);
  assert.equal(f.engine.takenDown,0);
  clearTimeout(f.engine.timer);
}));

test('in a draft that keeps changing, each take-down doubles the quiet time, up to twelve seconds',()=>withDir(async dir=>{
  assert.equal(ARM_QUIET_MAX,12000);
  const f=fixture(dir),waits=[];openDraft(f);
  const names=['a','b','c','d','e'];
  for(const name of names){
    f.engine.arm=ARM_QUIET;
    f.engine.setPersonal(skin(name));await f.run();
    waits.push(f.engine.armWait);
    // The quiet time runs out, as it would in a real draft.
    clearTimeout(f.engine.armTimer);f.engine.arm=1;f.engine.armLater(f.engine.signature());
    await untilStarts(f,waits.length);
  }
  assert.deepEqual(waits,[3000,6000,12000,12000,12000]);
  // The next draft starts from three seconds again.
  f.engine.setPersonal(null);f.engine.observe('Lobby');await f.run();
  assert.equal(f.engine.takenDown,0);
  clearTimeout(f.engine.timer);
}));

test('a party of five changing champions and skins all through the draft ends with exactly what is wanted',()=>withDir(async dir=>{
  const f=fixture(dir);openDraft(f);f.engine.arm=2;
  // The same "random" draft every run.
  let seed=20261111;const roll=n=>{seed=(seed*1103515245+12345)%2147483648;return seed%n;};
  const friends=[null,null,null,null];let own=null,changes=0;
  // Installing takes a moment, so changes land in the middle of the work as well.
  f.onInstall=()=>new Promise(done=>setTimeout(done,roll(3)));
  for(let step=0;step<80;step++){
    const who=roll(5),file=roll(6)?{...skin('s'+who+'-'+roll(4)),alias:'Champ'+who+roll(2)}:null;
    if(who===4){own=file;f.engine.setPersonal(own);}
    else{friends[who]=file;f.engine.setParty(friends.filter(Boolean));}
    if(!roll(4))f.engine.setSlots(new Map([['champ'+roll(5)+roll(2),roll(3)]]));
    changes++;
    // Sometimes at once, sometimes after the patcher had time to start.
    await new Promise(done=>setTimeout(done,[0,0,1,3,12][roll(5)]));
  }
  own={...skin('final'),alias:'Champ40'};f.engine.setPersonal(own);
  // The draft ends in the middle of it all.
  f.engine.observe('GameStart');f.engine.setHold({open:true,frozen:true,sealed:true});
  await until(()=>f.engine.settled);
  const wanted=f.engine.wanted().map(file=>file.key).sort();
  assert.deepEqual(f.engine.journal.staged.map(row=>row.key).sort(),wanted,'every skin wanted at the end, and no other');
  assert.equal(f.engine.applied,f.engine.signature());
  assert.equal(f.engine.status,'ready');
  const staged=f.engine.journal.staged.map(row=>row.modId).sort();
  assert.deepEqual(f.mods.filter(mod=>mod.enabled).map(mod=>mod.id).sort(),staged,'LTK holds exactly those, switched on');
  assert.equal(f.calls.filter(call=>call.startsWith('start')).at(-1),'start:'+f.mods.filter(mod=>mod.enabled).map(mod=>mod.id).join('+'),'and the last patcher start was for exactly those');
  assert.equal(f.patching,true);
  assert.ok(starts(f)<changes/2,'the patcher did not start for every change ('+starts(f)+' starts, '+changes+' changes)');
  clearTimeout(f.engine.timer);
}));

test('a friend\'s skin arriving after the patch patches once more under the frozen game',()=>withDir(async dir=>{
  const f=fixture(dir);openDraft(f);
  f.engine.setPersonal(skin('a'));await f.run();
  f.engine.observe('GameStart');f.engine.setHold({open:true,frozen:true,sealed:true});await f.run();
  f.engine.setParty([skin('friend')]);await f.run();
  assert.equal(starts(f),2);
  assert.ok(f.calls.includes('end'));
  clearTimeout(f.engine.timer);
}));

test('a skin LTK refuses is told during the draft, and the rest still go in when final',()=>withDir(async dir=>{
  const f=fixture(dir);f.flagged='staged-1';openDraft(f);
  f.engine.setPersonal(skin('bad','Bellion'));f.engine.setParty([skin('good')]);await f.run();
  assert.match(f.engine.error,/Bellion as a skin hack/);
  assert.equal(starts(f),0);
  assert.equal(f.engine.status,'failed');
  assert.equal(f.engine.settled,true);
  f.flagged='';f.failInstall.add(skin('bad').file);
  f.engine.setHold({open:true,frozen:true,sealed:true});
  assert.equal(f.engine.settled,false,'an earlier refusal must not let League go before the patch');
  await f.run();
  assert.equal(starts(f),1);
  assert.equal(f.engine.status,'failed');
  assert.equal(f.engine.settled,true);
  clearTimeout(f.engine.timer);
}));

test('a game that opened before the patch is told about the skin that missed it',()=>withDir(async dir=>{
  const f=fixture(dir);openDraft(f);
  f.engine.setPersonal(skin('a'));await f.run();
  assert.equal(f.engine.status,'ready');
  f.game=true;f.engine.observe('InProgress');await f.run();
  assert.equal(starts(f),0);
  assert.equal(f.engine.status,'failed');
  assert.match(f.engine.error,/in time/);
  clearTimeout(f.engine.timer);
}));

test('a dodge after a queued draft leaves nothing behind and nothing was patched',()=>withDir(async dir=>{
  const f=fixture(dir);openDraft(f);
  f.engine.setPersonal(skin('a'));await f.run();
  f.engine.setPersonal(null);f.engine.observe('Lobby');await f.run();
  assert.equal(starts(f),0);
  assert.deepEqual(f.mods,[{id:'own',enabled:true},{id:'other',enabled:false}]);
  assert.equal(f.engine.prepared,'');
  clearTimeout(f.engine.timer);
}));

const ahriSkin=(key='a',extra={})=>({...skin(key),alias:'Ahri',...extra});
const installed=f=>f.calls.filter(call=>call.startsWith('install:')).map(call=>call.slice(8));

test('over a selected skin, the skin goes in and its copy for that number beside it',()=>withDir(async dir=>{
  const f=fixture(dir);
  f.engine.observe('ChampSelect');f.engine.setSlots(new Map([['ahri',66]]));f.engine.setPersonal(ahriSkin());
  await f.run();
  assert.deepEqual(installed(f),['a.fantome','a-Ahri-66.fantome'],'the original first, so LTK judges it first');
  assert.equal(f.engine.status,'ready');
  assert.equal(f.engine.journal.staged.length,2);
  clearTimeout(f.engine.timer);
}));

test('a skin LTK refuses never gets a copy',()=>withDir(async dir=>{
  const f=fixture(dir);
  f.flagged='staged-1';
  f.engine.observe('ChampSelect');f.engine.setSlots(new Map([['ahri',66]]));f.engine.setPersonal(ahriSkin());
  await f.run();
  assert.deepEqual(installed(f),['a.fantome']);
  assert.equal(f.engine.journal.staged.length,0);
  assert.match(f.engine.error,/skin hack/);
  assert.deepEqual(f.slotFails,[],'and it is not treated as a skin to fall back for');
  clearTimeout(f.engine.timer);
}));

test('a skin that failed to install never gets a copy',()=>withDir(async dir=>{
  const f=fixture(dir);
  f.failInstall.add(skin('a').file);
  f.engine.observe('ChampSelect');f.engine.setSlots(new Map([['ahri',66]]));f.engine.setPersonal(ahriSkin());
  await f.run();
  assert.deepEqual(installed(f),['a.fantome']);
  clearTimeout(f.engine.timer);
}));

test('the base skin, or another champion, needs no copy',()=>withDir(async dir=>{
  const f=fixture(dir);
  f.engine.observe('ChampSelect');f.engine.setSlots(new Map([['ahri',0],['lux',4]]));f.engine.setPersonal(ahriSkin());
  await f.run();
  assert.deepEqual(installed(f),['a.fantome']);
  clearTimeout(f.engine.timer);
}));

test('changing the selected skin swaps the copy and leaves the skin in',()=>withDir(async dir=>{
  const f=fixture(dir);
  f.engine.observe('ChampSelect');f.engine.setSlots(new Map([['ahri',66]]));f.engine.setPersonal(ahriSkin());
  await f.run();
  const first=f.engine.journal.staged.map(row=>row.modId);
  f.calls.length=0;
  f.engine.setSlots(new Map([['ahri',12]]));
  await f.run();
  assert.deepEqual(installed(f),['a-Ahri-12.fantome']);
  assert.ok(f.calls.includes(`uninstall:${first[1]}`));
  assert.ok(!f.calls.includes(`uninstall:${first[0]}`));
  clearTimeout(f.engine.timer);
}));

test('the same selection does not restart LTK',()=>withDir(async dir=>{
  const f=fixture(dir);
  f.engine.observe('ChampSelect');f.engine.setSlots(new Map([['ahri',66]]));f.engine.setPersonal(ahriSkin());
  await f.run();
  f.calls.length=0;
  f.engine.setSlots(new Map([['ahri',66]]));
  f.engine.setSlots(new Map([['ahri',66],['lux',4]]));
  await f.run();
  assert.deepEqual(f.calls,[],'a friend choosing a skin is nothing to us until we have their champion');
  clearTimeout(f.engine.timer);
}));

test('a copy that cannot be built reports the failed pick without renaming the League skin',()=>withDir(async dir=>{
  const f=fixture(dir);
  f.noSlot=true;
  f.engine.buildNames=async()=>{assert.fail('do not rename a skin that did not apply');};
  f.engine.observe('ChampSelect');f.engine.setSlots(new Map([['ahri',66]]));f.engine.setPersonal(ahriSkin());
  await f.run();
  assert.deepEqual(installed(f),['a.fantome']);
  assert.equal(f.engine.status,'failed');
  assert.match(f.engine.error,/could not be applied over the skin selected in League/);
  assert.deepEqual(f.slotFails,['Ahri']);
  clearTimeout(f.engine.timer);
}));

test('a copy LTK refuses is removed and reported without stopping the match',()=>withDir(async dir=>{
  const f=fixture(dir);
  f.flagged='staged-2';
  f.engine.observe('ChampSelect');f.engine.setSlots(new Map([['ahri',66]]));f.engine.setPersonal(ahriSkin());
  await f.run();
  assert.deepEqual(f.engine.journal.staged.map(row=>row.modId),['staged-1']);
  assert.ok(f.calls.includes('uninstall:staged-2'));
  assert.match(f.engine.error,/could not be applied over the skin selected in League/);
  assert.equal(f.engine.settled,true);
  assert.deepEqual(f.slotFails,['Ahri']);
  clearTimeout(f.engine.timer);
}));

test('a friend on the team gets a copy for their selected skin too, and the Riot list skips Repair',()=>withDir(async dir=>{
  const f=fixture(dir);
  f.engine.observe('ChampSelect');
  f.engine.setSlots(new Map([['lux',7]]));
  f.engine.setParty([{...skin('b'),alias:'Lux',trusted:true}]);
  await f.run();
  assert.deepEqual(installed(f),['b.fantome','b-Lux-7.fantome']);
  assert.deepEqual(f.asked,[]);
  clearTimeout(f.engine.timer);
}));

test('after the match the copies go with the skins',()=>withDir(async dir=>{
  const f=fixture(dir);
  f.engine.observe('ChampSelect');f.engine.setSlots(new Map([['ahri',66]]));f.engine.setPersonal(ahriSkin());
  await f.run();
  const ids=f.engine.journal.staged.map(row=>row.modId);
  f.engine.setSlots(new Map());f.engine.setPersonal(null);f.engine.observe('None');
  await f.run();
  for(const id of ids)assert.ok(f.calls.includes(`uninstall:${id}`));
  assert.equal(f.engine.journal.staged.length,0);
  clearTimeout(f.engine.timer);
}));

const retryNow=async f=>{f.engine.retryAt=1;f.engine.observe(f.engine.phase);await f.run();};

test('a hiccup in LTK Manager is tried again, quietly, and League waits for it',()=>withDir(async dir=>{
  const f=fixture(dir);f.engine.observe('ChampSelect');f.engine.setPersonal(skin('a'));
  f.ensureError=new Error('LTK Manager closed.');await f.run();
  assert.equal(f.engine.error,'','nobody is told about what fixes itself');
  assert.ok(f.engine.retryAt>0);assert.equal(f.engine.settled,false);
  assert.match(f.retries[0],/trying again/);
  f.ensureError=null;await retryNow(f);
  assert.equal(f.engine.status,'ready');assert.equal(f.engine.settled,true);
}));

test('the last try is told, and League no longer waits',()=>withDir(async dir=>{
  const f=fixture(dir);f.engine.observe('ChampSelect');f.engine.setPersonal(skin('a'));
  f.ensureError=new Error('LTK Manager closed.');await f.run();await retryNow(f);await retryNow(f);
  assert.equal(f.engine.status,'failed');assert.match(f.engine.error,/closed/);
  assert.equal(f.engine.retryAt,0);assert.equal(f.engine.settled,true);
}));

test('a skin that only hit a hiccup gets another go, while the rest of the match is loaded',()=>withDir(async dir=>{
  const f=fixture(dir);const install=f.bridge.install;let once=true;
  f.bridge.install=async file=>{if(once&&file.includes('a.fantome')){once=false;throw new Error('LTK Manager did not respond in time.');}return install(file);};
  f.engine.observe('ChampSelect');f.engine.setPersonal(skin('a'));f.engine.setMods([skin('b')]);
  await f.run();
  assert.equal(f.calls.at(-1),'start:staged-1','the other one is loaded meanwhile');
  assert.equal(f.engine.settled,false);assert.equal(f.engine.error,'');
  await retryNow(f);
  assert.equal(f.engine.journal.staged.length,2);
  assert.equal(f.engine.status,'ready');assert.equal(f.engine.settled,true);
}));

test('a pick made while the last game is still closing goes in once it has',()=>withDir(async dir=>{
  const f=fixture(dir);f.game=true;f.engine.observe('ChampSelect');f.engine.setPersonal(skin('a'));await f.run();
  assert.match(f.engine.error,/next match/);assert.ok(f.engine.retryAt>0);
  f.game=false;await retryNow(f);
  assert.equal(f.calls.at(-1),'start:staged-1');
  assert.equal(f.engine.error,'');assert.equal(f.engine.status,'ready');
}));

test('a pick takes over an LTK Manager left open; a draft with no pick does not',()=>withDir(async dir=>{
  const f=fixture(dir);f.engine.observe('ChampSelect');await f.run();
  assert.deepEqual(f.ensures,[false]);
  f.connected=false;f.engine.setPersonal(skin('a'));await f.run();
  assert.equal(f.ensures.at(-1),true);
}));

test('a patcher that died during the draft is started again, a limited number of times',()=>withDir(async dir=>{
  const f=fixture(dir);f.engine.observe('ChampSelect');f.engine.setPersonal(skin('a'));await f.run();
  const starts=()=>f.calls.filter(call=>call.startsWith('start')).length;
  assert.equal(starts(),1);
  assert.equal(await f.engine.checkPatcher(),false,'alive');
  f.hostDead=true;
  const look=async()=>{f.engine.patcherCheckAt=0;return f.engine.checkPatcher();};
  assert.equal(await look(),false,'it restarts itself once, so one look proves nothing');
  assert.equal(await look(),true);await f.run();
  assert.equal(starts(),2);assert.equal(f.engine.status,'ready');
  assert.equal(await f.engine.checkPatcher({now:true}),true,'the last look before a game goes waits for nothing');
  await f.run();assert.equal(starts(),3);
  assert.equal(await f.engine.checkPatcher({now:true}),false,'only so many times');
  assert.match(f.retries[0],/patcher stopped/);
}));

test('a patcher is not restarted under a running game',()=>withDir(async dir=>{
  const f=fixture(dir);f.engine.observe('ChampSelect');f.engine.setPersonal(skin('a'));await f.run();
  f.hostDead=true;f.game=true;
  assert.equal(await f.engine.checkPatcher({now:true}),false);
  assert.equal(f.engine.settled,true);
}));

test('a game that could not wait is told about the skin that missed it',()=>withDir(async dir=>{
  const f=fixture(dir);f.engine.observe('ChampSelect');f.engine.setPersonal(skin('a'));
  f.ensureError=new Error('LTK Manager closed.');await f.run();
  assert.equal(f.engine.status,'applying');
  f.engine.observe('InProgress');await f.run();
  assert.equal(f.engine.status,'failed');assert.match(f.engine.error,/in time/);
}));

test('confirmApplied: a skin missing from LTK\'s overlay gets one more patch, and never holds League for ever',async()=>{
  const {SkinEngine}=await import('../src/engine.mjs');
  const asked=[];let missing=['Aatrox'];
  const bridge={overlayMissing:async(champions,slots)=>{asked.push({champions,slots});return missing;}};
  const engine=new SkinEngine({bridge,dataDir:'.',onRetry:()=>{}});
  engine.schedule=()=>{};
  assert.equal(await engine.confirmApplied(),true,'nothing patching, nothing to confirm');
  engine.journal.patching=true;
  engine.personal={key:'a',alias:'Aatrox',label:'Skin'};
  engine.setSlots(new Map([['aatrox',8]]));
  engine.party=[{key:'b',alias:'Zed',label:'Friend'}];engine.mods=[{key:'m',label:'A mod'}];
  engine.failures=new Map([['b','refused']]);
  engine.applied=engine.signature();
  assert.equal(await engine.confirmApplied(),false);
  assert.deepEqual(asked.at(-1),{champions:['Aatrox'],slots:new Map([['Aatrox',8]])});
  assert.equal(engine.applied,'repatch');
  engine.applied=engine.signature();
  assert.equal(await engine.confirmApplied(),true,'once per set of skins');
  assert.match(engine.failureFor('a'),/missing from LTK Manager/);
  missing=[];assert.equal(await engine.confirmApplied(),true);
  bridge.overlayMissing=async()=>{throw new Error('unreadable');};
  engine.failures.delete('a');engine.confirmedFor='';
  assert.equal(await engine.confirmApplied(),true,'not knowing is no reason to hold a game');
});

test('a skin prepared on the pick is checked and repaired by LTK, kept, and its working file removed',()=>withDir(async dir=>{
  const f=fixture(dir),pick={...skin('fresh'),alias:'Ahri'},working=path.join(dir,'working.fantome'),kept=[];
  await writeFile(working,'working copy');
  let there;f.onInstall=async()=>{there=await access(working).then(()=>true,()=>false);};
  f.engine.prepareFile=async requested=>({...requested,file:working,prepared:false,working:true});
  f.engine.keepPrepared=async(requested,modId)=>{kept.push([requested.key,modId]);};
  f.engine.observe('ChampSelect');f.engine.setPersonal(pick);await f.run();
  assert.equal(f.engine.status,'ready');assert.equal(there,true,'still there for LTK to read');
  assert.deepEqual(f.asked,[['staged-1',true]],'LTK Repair runs on it');
  assert.deepEqual(kept,[[pick.key,'staged-1']]);
  assert.equal(await access(working).then(()=>true,()=>false),false);
}));

test('an old copy is checked by LTK and kept as a new one',()=>withDir(async dir=>{
  const f=fixture(dir),pick={...skin('old'),alias:'Ahri'},kept=[];
  f.engine.prepareFile=async requested=>({...requested,file:'C:/prepared/old.fantome',prepared:false});
  f.engine.keepPrepared=async requested=>{kept.push(requested.key);};
  f.engine.observe('ChampSelect');f.engine.setPersonal(pick);await f.run();
  assert.deepEqual(f.asked,[['staged-1',true]]);assert.deepEqual(kept,[pick.key]);
}));

test('a slot copy starts from what was kept, so Repair does not run twice',()=>withDir(async dir=>{
  const f=fixture(dir),pick={...skin('fresh'),alias:'Ahri'},built=[];let kept=false;
  f.engine.prepareFile=async requested=>kept?{...requested,file:'C:/prepared/kept.fantome',prepared:true}:{...requested,file:path.join(dir,'working.fantome'),prepared:false,working:true};
  f.engine.keepPrepared=async()=>{kept=true;};
  f.buildSlot=async request=>{built.push(request.file);return 'C:/slots/kept-66.fantome';};
  f.engine.setSlots(new Map([['ahri',66]]));f.engine.observe('ChampSelect');f.engine.setPersonal(pick);await f.run();
  assert.deepEqual(built,['C:/prepared/kept.fantome']);
  assert.deepEqual(f.asked,[['staged-1',true]],'only the original was repaired');
  assert.deepEqual(f.engine.journal.staged.map(row=>row.key),[pick.key,`${pick.key}@66`]);
}));

test('failing to keep a copy never costs the player their skin',()=>withDir(async dir=>{
  const f=fixture(dir),pick={...skin('fresh'),alias:'Ahri'};
  f.engine.prepareFile=async requested=>({...requested,file:path.join(dir,'working.fantome'),prepared:false,working:true});
  f.engine.keepPrepared=async()=>{throw new Error('disk full');};
  f.engine.observe('ChampSelect');f.engine.setPersonal(pick);await f.run();
  assert.equal(f.engine.status,'ready');assert.equal(f.engine.journal.staged.length,1);
  assert.match(f.retries.join(),/was not kept: disk full/);
}));

test('a skin LTK refuses on the pick is told, not kept',()=>withDir(async dir=>{
  const f=fixture(dir),pick={...skin('bad','Bad Skin'),alias:'Ahri'};let kept=0;
  f.flagged='staged-1';
  f.engine.prepareFile=async requested=>({...requested,file:path.join(dir,'working.fantome'),prepared:false,working:true});
  f.engine.keepPrepared=async()=>{kept++;};
  f.engine.observe('ChampSelect');f.engine.setPersonal(pick);await f.run();
  assert.equal(kept,0);assert.equal(f.engine.status,'failed');assert.match(f.engine.failureFor(pick.key),/Bad Skin/);
}));

test('nothing already prepared or from Riot is kept again',()=>withDir(async dir=>{
  const f=fixture(dir);let kept=0;
  f.engine.prepareFile=async requested=>({...requested,file:'C:/prepared/done.fantome',prepared:true});
  f.engine.keepPrepared=async()=>{kept++;};
  f.engine.observe('ChampSelect');f.engine.setPersonal({...skin('done'),alias:'Ahri'});await f.run();
  f.engine.setPersonal({...skin('riot'),alias:'Ahri',trusted:true});await f.run();
  assert.equal(kept,0);
}));

const gone=()=>{throw Object.assign(new Error('Mod not found'),{code:'MOD_NOT_FOUND'});};

test('a skin no longer wanted that is already gone from LTK Manager does not stop the match',()=>withDir(async dir=>{
  const f=fixture(dir);
  f.engine.observe('ChampSelect');f.engine.setPersonal(skin('a'));await f.run();
  // Still listed when the library is read, gone by the time it is removed.
  f.bridge.uninstall=async()=>gone();
  f.engine.setPersonal(skin('b'));await f.run();
  assert.equal(f.engine.status,'ready');
  assert.deepEqual(f.engine.journal.staged.map(row=>row.key),[skin('b').key]);
  assert.ok(f.calls.includes('install:b.fantome'));
}));

test('a staged skin the player removed from LTK Manager goes in again',()=>withDir(async dir=>{
  const f=fixture(dir);
  f.engine.observe('ChampSelect');f.engine.setPersonal(skin('a'));await f.run();
  f.mods=f.mods.filter(mod=>mod.id!=='staged-1');
  f.engine.repatch();await f.run();
  assert.equal(f.calls.filter(call=>call==='install:a.fantome').length,2);
  assert.equal(f.engine.status,'ready');
  assert.deepEqual(f.engine.journal.staged.map(row=>row.modId),['staged-2']);
  assert.match(f.calls.at(-1),/^start:.*staged-2/);
}));

test('a refused skin already gone from LTK Manager is still reported as refused',()=>withDir(async dir=>{
  const f=fixture(dir);
  f.flagged='staged-1';f.bridge.uninstall=async()=>gone();
  f.engine.observe('ChampSelect');f.engine.setPersonal(skin('a','Bad Skin'));await f.run();
  assert.equal(f.engine.status,'failed');
  assert.match(f.engine.error,/Bad Skin as a skin hack/);
  assert.deepEqual(f.engine.journal.staged,[]);
}));

test('any other failure removing a skin is still a failure',()=>withDir(async dir=>{
  const f=fixture(dir);
  f.engine.observe('ChampSelect');f.engine.setPersonal(skin('a'));await f.run();
  f.bridge.uninstall=async()=>{throw Object.assign(new Error('LTK is busy'),{code:'X',plain:true});};
  f.engine.setPersonal(skin('b'));await f.run();
  assert.equal(f.engine.status,'failed');
  assert.match(f.engine.error,/LTK is busy/);
}));

test('the pick\'s name goes in beside it, for the skin selected in the client',()=>withDir(async dir=>{
  const f=fixture(dir),pick={...skin('named','Yumeko Ahri'),alias:'Ahri'},built=[];
  f.engine.buildNames=async request=>{built.push(request);return 'C:/slots/name.fantome';};
  f.engine.setSlots(new Map([['ahri',66]]));f.engine.observe('ChampSelect');f.engine.setPersonal(pick);await f.run();
  assert.deepEqual(built.map(({alias,slot,name})=>({alias,slot,name})),[{alias:'ahri',slot:66,name:'Yumeko Ahri'}]);
  assert.deepEqual(f.engine.journal.staged.map(row=>row.key),[pick.key,`${pick.key}@66`,'name:ahri:66:Yumeko Ahri']);
  assert.equal(f.engine.status,'ready');
}));

test('with the default skin selected the name goes on the champion, and a stand-in label adds nothing',()=>withDir(async dir=>{
  const f=fixture(dir),pick={...skin('named','Yumeko Ahri'),alias:'Ahri'};
  f.engine.buildNames=async()=>'C:/slots/name.fantome';
  f.engine.observe('ChampSelect');f.engine.setPersonal(pick);await f.run();
  assert.deepEqual(f.engine.journal.staged.map(row=>row.key),[pick.key,'name:ahri:0:Yumeko Ahri']);
  const g=fixture(dir),unnamed={...skin('riot','Riot skin'),alias:'Ahri'};
  g.engine.buildNames=async()=>assert.fail('there is no name to show');
  assert.deepEqual(g.engine.wanted.call(Object.assign(g.engine,{personal:unnamed})).map(file=>file.key),[unnamed.key]);
}));

test('a name that cannot be added costs only the name',()=>withDir(async dir=>{
  for(const failure of ['none','throws']){
    const f=fixture(dir),pick={...skin('named','Yumeko Ahri'),alias:'Ahri'};
    f.engine.buildNames=async()=>{if(failure==='throws')throw new Error('League is updating');return null;};
    f.engine.setSlots(new Map([['ahri',66]]));f.engine.observe('ChampSelect');f.engine.setPersonal(pick);await f.run();
    assert.deepEqual(f.engine.journal.staged.map(row=>row.key),[pick.key,`${pick.key}@66`]);
    assert.deepEqual(f.slotFails,[],'the skin is not swapped for the base skin');
    assert.equal(f.engine.status,'ready');assert.equal(f.engine.error,'');
  }
}));

test('LTK checks the name even when its skin was prepared, and a flagged name is taken out',()=>withDir(async dir=>{
  const f=fixture(dir),pick={...skin('named','Yumeko Ahri'),alias:'Ahri'};
  f.engine.prepareFile=async requested=>({...requested,file:'C:/prepared/yumeko.fantome',prepared:true});
  f.engine.buildNames=async()=>'C:/slots/name.fantome';
  f.flagged='staged-2';
  f.engine.observe('ChampSelect');f.engine.setPersonal(pick);await f.run();
  assert.deepEqual(f.asked.map(row=>row[0]),['staged-2']);
  assert.deepEqual(f.engine.journal.staged.map(row=>row.key),[pick.key]);
  assert.ok(!f.mods.some(mod=>mod.id==='staged-2'));
  assert.deepEqual(f.slotFails,[]);assert.equal(f.engine.status,'ready');
}));
