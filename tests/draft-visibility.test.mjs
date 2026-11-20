import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import * as model from '../src/model.mjs';

// Exercise the actual window-placement functions without touching League or personal data.
const source=await readFile(new URL('../src/main.cjs',import.meta.url),'utf8');
const functions=['syncDraftVisibility','launcherAllowed','clearForGame','restoreDashboard','placeOverlay','placeLauncher','syncOutsideClicks'];
const code=functions.map(name=>{
  const start=source.indexOf(`function ${name}(`);
  assert.ok(start>=0,name);
  return source.slice(start,source.indexOf('\n}',start)+2);
}).join('\n');
function window(){
  return {visible:true,topmost:true,shows:0,bounds:{x:0,y:0,width:100,height:100},
    isDestroyed(){return false;},isVisible(){return this.visible;},isFocused(){return true;},
    hide(){this.visible=false;},showInactive(){this.visible=true;this.shows++;},
    setAlwaysOnTop(value){this.topmost=value;},setSkipTaskbar(){},moveTop(){},
    getBounds(){return this.bounds;},setBounds(value){this.bounds=value;}};
}
function fixture({docked=false}={}){
  const client={pid:12,x:0,y:0,width:1600,height:900};
  const context=vm.createContext({model,preview:false,process:{pid:20,platform:'test'},riot:{RIOT_SKINS_OFF:false},
    draftVisibility:new model.DraftVisibility(),guideWatcher:{sighting:{phase:'ChampSelect'},connected:true},
    hold:{phase:'ChampSelect',frozenOnce:false,released:false},
    state:{mode:'open',champion:'Ahri',leagueConnected:true,partyDocked:docked},
    dashboard:window(),overlay:window(),launcher:window(),
    savedDashboard:docked?{visible:true,bounds:{x:25,y:25,width:900,height:600}}:null,
    foregroundLeftAt:0,FOREGROUND_GRACE:1200,panelHiddenBy:'',nextPanelRaise:Infinity,
    nextLauncherRaise:Infinity,launcherPlaced:'',lastClient:client,
    outsideClicks:{watch(){},stop(){}},screen:{screenToDipRect(_window,rect){return rect;}},
    tracker:{clientWindow(){return client;},foregroundPid(){return client.pid;},
      foregroundWindow(){return {...client,visible:true};}},errorLog:{note(){}}});
  vm.runInContext(code,context);
  context.syncDraftVisibility();
  return context;
}
for(const docked of [false,true])for(const mode of ['open','tab']){
  test(`draft end hides focused dashboard, launcher and ${mode} panel (docked=${docked})`,()=>{
    const c=fixture({docked});c.state.mode=mode;
    c.guideWatcher.sighting.phase='GameStart';
    c.syncDraftVisibility();
    for(const name of ['dashboard','overlay','launcher'])assert.equal(c[name].visible,false,name);
    assert.equal(c.dashboard.topmost,false);
    assert.equal(c.state.partyDocked,false);
    assert.equal(c.dashboard.shows,0,'never raise the previously visible dashboard');
    for(const phase of ['GameStart','Reconnect','InProgress','WaitingForStats','EndOfGame','Lobby','']){
      c.guideWatcher.sighting.phase=phase;
      // Simulate a delayed poll retaining an open panel and the League client returning to front.
      c.state.mode=mode;c.hold.released=true;
      for(let tick=0;tick<3;tick++){c.placeOverlay();c.placeLauncher();}
      for(const name of ['dashboard','overlay'])assert.equal(c[name].visible,false,`${phase}: ${name}`);
      // The corner launcher stays away during the match and is back once it is over (9.3).
      const inMatch=['GameStart','Reconnect','InProgress'].includes(phase);
      assert.equal(c.launcher.visible,!inMatch,`${phase}: launcher`);
    }
    c.guideWatcher.sighting.phase='ChampSelect';c.hold.frozenOnce=false;
    c.placeOverlay();c.placeLauncher();
    assert.equal(c.overlay.visible,true);assert.equal(c.launcher.visible,true);
    assert.equal(c.dashboard.visible,false,'a new draft does not reopen the lobby');
  });
}
test('early freeze closes everything before the phase changes and release cannot reopen it',()=>{
  const c=fixture();c.hold.frozenOnce=true;
  c.syncDraftVisibility();c.hold.released=true;
  c.placeOverlay();c.placeLauncher();
  for(const name of ['dashboard','overlay','launcher'])assert.equal(c[name].visible,false,name);
});
test('a dodge closes the lobby before any champion was locked in',()=>{
  const c=fixture({docked:true});c.state.champion=null;c.state.mode='hidden';
  c.guideWatcher.sighting.phase='Lobby';c.syncDraftVisibility();
  assert.equal(c.dashboard.visible,false);assert.equal(c.launcher.visible,false);
});
test('the corner launcher shows in the lobby, but not over another program',()=>{
  const c=fixture();c.guideWatcher.sighting.phase='Lobby';c.state.mode='hidden';c.syncDraftVisibility();
  c.placeLauncher();assert.equal(c.launcher.visible,true);
  c.tracker.foregroundPid=()=>99;c.placeLauncher();assert.equal(c.launcher.visible,false);
});
test('a frozen draft keeps the launcher away until the phase leaves the match',()=>{
  const c=fixture();c.hold.frozenOnce=true;c.syncDraftVisibility();
  c.placeLauncher();assert.equal(c.launcher.visible,false);
  c.guideWatcher.sighting.phase='InProgress';c.placeLauncher();assert.equal(c.launcher.visible,false);
  c.guideWatcher.sighting.phase='EndOfGame';c.placeLauncher();assert.equal(c.launcher.visible,true);
});
