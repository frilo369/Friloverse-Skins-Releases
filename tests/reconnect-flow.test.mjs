import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import * as model from '../src/model.mjs';
import {GameHold} from '../src/game-hold.mjs';
import guards from '../src/run-guards.cjs';

// Real controller, poll, catalogue refresh and placement; no personal data or League processes.
const source=await readFile(new URL('../src/main.cjs',import.meta.url),'utf8');
const names=['poll','syncDraftVisibility','launcherAllowed','clearForGame','clearForDraft',
  'restoreDashboard','placeOverlay','placeLauncher','syncOutsideClicks','refreshSkinsSoon','refreshSkins','customAndLocal','markPicked'];
const code=names.map(name=>{
  const match=new RegExp(`(?:async )?function ${name}\\(`).exec(source);
  assert.ok(match,name);
  return source.slice(match.index,source.indexOf('\n}',match.index)+2);
}).join('\n');
function window(){
  return {visible:false,focused:false,bounds:{},isDestroyed(){return false;},
    isVisible(){return this.visible;},isFocused(){return this.focused;},
    hide(){this.visible=false;},showInactive(){this.visible=true;},
    setAlwaysOnTop(){},setSkipTaskbar(){},moveTop(){},
    getBounds(){return this.bounds;},setBounds(value){this.bounds=value;}};
}
function fixture(){
  const client={pid:12,x:0,y:0,width:1600,height:900};
  const c=vm.createContext({model,...guards,Date,setImmediate,console,riot:{RIOT_SKINS_OFF:false},
    preview:false,closed:false,process:{pid:20,platform:'test'},polls:new guards.PollGate(),pollDraftId:null,
    pollWanted:false,ltkFound:true,ltkPresence:{due:false},installingLtk:false,
    draftNoted:false,notedChampionLoss:null,customCards:null,CUSTOM_LIST_AGE:3000,
    state:{mode:'hidden',champion:null,champions:[{key:'103',name:'Ahri'},{key:'1',name:'Annie'}],
      skins:[],leagueConnected:true,partyDocked:false},
    draftVisibility:new model.DraftVisibility(),guideWatcher:{sighting:{phase:'ChampSelect',champion:103},connected:true,draftId:1},
    dashboard:window(),overlay:window(),launcher:window(),savedDashboard:null,
    foregroundLeftAt:0,FOREGROUND_GRACE:1200,panelHiddenBy:'',nextPanelRaise:Infinity,
    nextLauncherRaise:Infinity,launcherPlaced:'',lastClient:client,bridge:{notice:''},
    outsideClicks:{watch(){},stop(){}},screen:{screenToDipRect(_window,rect){return rect;}},
    tracker:{clientWindow(){return client;},foregroundPid(){return client.pid;},focusClient(){},
      foregroundWindow(){return {...client,visible:true};}},errorLog:{note(){}},
    choices:{pick(){return null;},clear(){}},forcedBase:{clear(){}},
    catalogue:{ready:true,async forChampion(){return [];}},
    database:{async list(){return {skins:[]};}},localDatabase:{async list(){return {skins:[]};}},riotCardsFor:(_row,entries)=>entries,
    readTeamSlots(){},leagueClient:{draftTimeLeft:()=>null},emitState(){},
  });
  c.engine={settled:true,status:'ready',repatch(){},setHold(){},setPersonal(){},observe(phase){this.phase=phase;}};
  c.party={ownChampion:null,settling:false,report(){},refreshLocal(){},observe(champion){if(champion)this.ownChampion=champion;}};
  c.hold=new GameHold({engine:c.engine,party:c.party,
    start:({onEvent})=>{c.guardEvent=onEvent;return {send(){},close(){}};},
    onChange:()=>{c.syncDraftVisibility();c.placeOverlay();c.placeLauncher();},
  });
  c.hold.schedule=()=>{};
  c.noGameProcess=async()=>c.gameGone===true;
  c.place=()=>c.placeOverlay();
  vm.runInContext(`const skinReads=new PollGate();\n${code}`,c);
  c.phase=async(phase,gameGone=false)=>{
    c.guideWatcher.sighting={phase,champion:103};c.gameGone=gameGone;
    await c.poll();c.placeLauncher();
  };
  return c;
}
for(const from of ['GameStart','InProgress'])test(`quitting ${from} offers skins on every return, even with unchanged Reconnect phase`,async t=>{
  const c=fixture();t.after(()=>c.hold.dispose());
  await c.phase('ChampSelect');assert.equal(c.overlay.visible,true);
  c.state.mode='tab';
  c.guardEvent({event:'suspended',pid:1,created:1});
  c.hold.letGo();
  await c.phase(from);
  assert.equal(c.overlay.visible,false);
  for(let quit=0;quit<3;quit++){
    await c.phase('Reconnect',true);
    assert.equal(c.state.champion,'Ahri');assert.equal(c.state.mode,'open');
    assert.equal(c.overlay.visible,true);assert.equal(c.launcher.visible,true);
    assert.equal(c.hold.choicesOpen(),true);
    c.state.mode='tab';await c.poll();assert.equal(c.state.mode,'tab','manual fold stays');
    c.guardEvent({event:'suspended',pid:quit+2,created:quit+2});
    assert.equal(c.hold.choicesOpen(),false,'closes before the next client reading');
    assert.equal(c.overlay.visible,false);assert.equal(c.launcher.visible,false);
    c.hold.letGo();
    // No UI poll between launching and quitting: the phase still says Reconnect.
  }
  await c.phase('Lobby');assert.equal(c.overlay.visible,false);
});

test('Reconnect while a game exists and an automatic restart never offer skin choices',async t=>{
  const c=fixture();t.after(()=>c.hold.dispose());
  await c.phase('ChampSelect');await c.phase('GameStart');
  await c.phase('Reconnect',false);assert.equal(c.overlay.visible,false);
  c.hold.restarting=true;
  await c.phase('Reconnect',true);assert.equal(c.overlay.visible,false);
  assert.equal(c.state.reconnect,false);
});

test('Reconnect closes a docked Party on game return, and refusal to freeze also closes choices',async t=>{
  const c=fixture();t.after(()=>c.hold.dispose());
  await c.phase('Reconnect',true);
  c.state.partyDocked=true;c.dashboard.visible=true;c.dashboard.focused=true;
  c.savedDashboard={visible:true,bounds:{x:10,y:10,width:800,height:450}};
  c.placeOverlay();assert.equal(c.overlay.visible,false,'Party occupies the client');
  c.guardEvent({event:'blocked',pid:2,message:'refused'});
  assert.equal(c.hold.choicesOpen(),false);
  assert.equal(c.dashboard.visible,false);assert.equal(c.state.partyDocked,false);
  assert.equal(c.overlay.visible,false);
  await c.phase('Reconnect',true);assert.equal(c.overlay.visible,true);
});

test('the real poll restores controls and follows Reconnect while catalogue IO is pending',async t=>{
  const c=fixture();t.after(()=>c.hold.dispose());
  let finish;
  c.catalogue.forChampion=()=>new Promise(resolve=>{finish=resolve;});
  await c.phase('ChampSelect');
  assert.equal(c.state.mode,'open');assert.equal(c.overlay.visible,true);
  c.hold.letGo();await c.phase('InProgress');await c.phase('Reconnect',true);
  assert.equal(c.overlay.visible,true);assert.equal(c.state.reconnect,true);
  await c.phase('InProgress');finish([{id:'late',name:'Late card'}]);
  await new Promise(setImmediate);
  assert.equal(c.overlay.visible,false);assert.equal(c.state.skins.length,0,'old cards cannot reopen a finished selection');
});

test('a champion swap does not wait for the previous champions slow folder',async t=>{
  const c=fixture();t.after(()=>c.hold.dispose());
  let finish;
  c.catalogue.forChampion=id=>id===103?new Promise(resolve=>{finish=resolve;}):Promise.resolve([{id:'annie',name:'Annie'}]);
  await c.phase('ChampSelect');
  c.guideWatcher.sighting.champion=1;await c.poll();
  await new Promise(setImmediate);
  assert.equal(c.state.champion,'Annie');assert.equal(c.state.skins[0].id,'annie');
  finish([{id:'ahri',name:'Ahri'}]);await new Promise(setImmediate);
  assert.equal(c.state.skins[0].id,'annie');
});

test('a new draft guard clears a stale freeze even if the poll missed the lobby',async t=>{
  const c=fixture();t.after(()=>c.hold.dispose());
  await c.phase('ChampSelect');c.guardEvent({event:'suspended',pid:1,created:1});
  assert.equal(c.overlay.visible,false);
  // Watcher sees the lobby and new draft while the old poll is still finishing.
  c.guideWatcher.sighting.phase='Lobby';c.syncDraftVisibility();
  c.guideWatcher.sighting.phase='ChampSelect';c.syncDraftVisibility();
  c.guideWatcher.draftId++;await c.poll();
  assert.equal(c.overlay.visible,true);assert.equal(c.hold.choicesOpen(),true);
});

test('a new draft the poll reached without seeing the lobby never hands the engine the last pick',async t=>{
  const c=fixture();t.after(()=>c.hold.dispose());
  let picked={champion:'Ahri',skin:'ahri-skin'};
  c.choices={pick(){return picked;},clear(){picked=null;}};
  const handed=[];c.engine.setPersonal=pick=>handed.push(pick);
  await c.phase('ChampSelect');
  assert.deepEqual(handed.at(-1),{champion:'Ahri',skin:'ahri-skin'});
  // The watcher saw the lobby and a new draft; the poll only ever sees champion select.
  c.guideWatcher.draftId++;await c.poll();
  assert.equal(handed.at(-1),null,'the new draft starts with no pick');
  // A pick made in the new draft stays for the rest of it.
  picked={champion:'Ahri',skin:'new-pick'};await c.poll();
  assert.deepEqual(handed.at(-1),{champion:'Ahri',skin:'new-pick'});
});
