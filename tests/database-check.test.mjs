import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

// Execute the production orchestration with stand-ins; do not launch Electron or
// touch the player's databases. Keep the returned counts all the way to Settings.
const source=await readFile(new URL('../src/main.cjs',import.meta.url),'utf8');
const functions=['checkRiotSkins','runRiotCheck','fetchRiotChanges','runRiotFetch','checkDatabases']
  .map(name=>{
    const body=source.match(new RegExp(`^async function ${name}\\([^]*?^}`, 'm'))?.[0];
    assert.ok(body,`production function ${name} exists`);return body;
  }).join('\n');
function fixture({riotOff=false}={}){
  const f={riot:{RIOT_SKINS_OFF:riotOff},withdrawnRuns:0,preview:false,closed:false,updating:false,riotChecking:false,riotFetching:false,riotFetchRetry:null,
    lastRiotLeftNote:'',collectionRestoreQueued:false,state:{},results:[],fetches:0,checks:0,
    catalogue:{waiting:new Set(['form']),ready:true,remoteError:'',
      load:async()=>{},checkRemote:async()=>{f.checks++;return {changed:false};},audit:async()=>({queued:1}),
      refreshNames:async()=>false,fetchChanged:async()=>{f.fetches++;return {downloaded:2,missing:0,left:0};}},
    riotCardsHeld:new Map(),riotRetry:{cancel(){},set(){}},
    setTask(){},emitState(){},removeWithdrawn:async()=>{f.withdrawnRuns++;},removeUnusedRiotFiles:async()=>{},
    noGameProcess:async()=>true,errorLog:{note(){},failed(){}},customImportDone:Promise.resolve(),
    syncCustomCollection:async()=>({added:[],updated:[],failed:[]}),
    showCheckResult:message=>f.results.push(message),setTimeout:()=>({unref(){}}),clearTimeout(){},
  };
  vm.createContext(f);vm.runInContext(functions,f);return f;
}

test('Settings includes Riot downloads in its final database result',async()=>{
  const f=fixture();await f.checkDatabases();
  assert.equal(f.results.at(-1),'Databases checked: added or updated 2 files.');
  assert.equal(f.state.databaseChecking,false);
});

test('with Riot skins off (10.6) a check reads no Riot list but still clears withdrawn skins',async()=>{
  const f=fixture({riotOff:true});await f.checkDatabases();
  assert.equal(f.checks,0);assert.equal(f.fetches,0);
  assert.equal(f.withdrawnRuns,1);
  assert.equal(f.results.at(-1),'Databases checked: nothing is missing.');
  assert.equal(f.state.riotUpdateStatus,undefined);
});

test('an empty Riot queue can report a complete check',async()=>{
  const f=fixture();f.catalogue.waiting.clear();await f.checkDatabases();
  assert.equal(f.fetches,0);assert.equal(f.results.at(-1),'Databases checked: nothing is missing.');
});

test('unfinished, missing-on-GitHub and failed Riot checks never claim nothing is missing',async()=>{
  for(const [outcome,expected] of [
    [{downloaded:0,missing:0,left:3,stopped:true},/3 Riot skin files left for later/],
    [{downloaded:0,missing:1,left:0},/1 Riot skin file is missing from GitHub/],
    [new Error('offline'),/Riot skin files could not be checked/],
  ]){
    const f=fixture();f.catalogue.fetchChanged=async()=>{if(outcome instanceof Error)throw outcome;return outcome;};
    await f.checkDatabases();assert.match(f.results.at(-1),expected);
    assert.doesNotMatch(f.results.at(-1),/nothing is missing/);
  }
  const f=fixture();f.catalogue.waiting.clear();f.catalogue.remoteError='offline';await f.checkDatabases();
  assert.match(f.results.at(-1),/Riot skin list could not be checked/);
  assert.doesNotMatch(f.results.at(-1),/nothing is missing/);
});

test('a manual check joins an automatic Riot check and receives its downloads',async()=>{
  const f=fixture();let finish,entered;
  const started=new Promise(resolve=>entered=resolve);
  f.catalogue.fetchChanged=()=>{f.fetches++;entered();return new Promise(resolve=>finish=resolve);};
  const automatic=f.checkRiotSkins();await started;
  const manual=f.checkDatabases();
  finish({downloaded:4,missing:0,left:0});await Promise.all([automatic,manual]);
  assert.equal(f.checks,1);assert.equal(f.fetches,1);
  assert.equal(f.results.at(-1),'Databases checked: added or updated 4 files.');
  assert.equal(f.riotChecking,false);assert.equal(f.riotFetching,false);
});

test('a list check joins an already-running Riot retry instead of losing its result',async()=>{
  const f=fixture();let finish;
  f.catalogue.fetchChanged=()=>{f.fetches++;return new Promise(resolve=>finish=resolve);};
  const retry=f.fetchRiotChanges();const manual=f.checkDatabases();
  // Let the list check reach the fetch while the retry is still pending.
  await new Promise(resolve=>setImmediate(resolve));
  finish({downloaded:1,missing:0,left:2});await Promise.all([retry,manual]);
  assert.equal(f.fetches,1);assert.match(f.results.at(-1),/added or updated 1 file.*2 Riot skin files left/);
});
