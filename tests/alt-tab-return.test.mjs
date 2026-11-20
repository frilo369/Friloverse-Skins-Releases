import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const {AltTabReturn,altTabPlan,SETTLE}=createRequire(import.meta.url)('../src/alt-tab-return.cjs');

const GUIDE={pid:1},CLIENT={pid:2},RIOT={pid:3},GAME={pid:4},TERMINAL={pid:5},SWITCHER={pid:99};
function rig(front,guideOpen=true){
  const s={alt:false,tab:false,front,time:1000,sent:0,guideOpen};
  const send=to=>()=>{s.sent++;s.front=to;};
  const watcher=new AltTabReturn({
    altDown:()=>s.alt,tabDown:()=>s.tab,foreground:()=>s.front,isSwitcher:w=>w===SWITCHER,now:()=>s.time,
    planFor:from=>altTabPlan(from,{guideOpen:s.guideOpen,ownPid:GUIDE.pid,isGame:w=>w===GAME,isGuide:w=>w===GUIDE,
      clientKind:id=>id===CLIENT.pid?'league':id===RIOT.pid?'riot':'',toGame:send(GAME),toGuide:send(GUIDE)}),
  });
  const step=change=>{Object.assign(s,change);watcher.poll();};
  const tap=()=>{step({tab:true});step({tab:false});};
  const altTab=lands=>{step({});step({alt:true});step({front:SWITCHER});tap();step({alt:false});step({front:lands});};
  return {s,step,tap,altTab};
}

test('one Alt+Tab from the guide that lands on the Riot Client goes to the game',()=>{
  const {s,altTab}=rig(GUIDE);
  altTab(RIOT);
  assert.equal(s.sent,1);assert.equal(s.front,GAME);
});
test('one Alt+Tab from the guide that lands on an earlier program goes to the game',()=>{
  const {s,altTab}=rig(GUIDE);
  altTab(TERMINAL);
  assert.equal(s.sent,1);assert.equal(s.front,GAME);
});
test('one Alt+Tab from the game returns to the open guide, wherever Windows landed',()=>{
  const {s,altTab}=rig(GAME);
  altTab(TERMINAL);
  assert.equal(s.sent,1);assert.equal(s.front,GUIDE);
});
test('Alt+Tab keeps toggling between the guide and the game',()=>{
  const {s,altTab}=rig(GUIDE);
  altTab(RIOT);assert.equal(s.front,GAME);
  altTab(TERMINAL);assert.equal(s.front,GUIDE);
  altTab(TERMINAL);assert.equal(s.front,GAME);
  assert.equal(s.sent,3);
});
test('landing where the toggle wanted anyway sends nothing',()=>{
  const fromGuide=rig(GUIDE);fromGuide.altTab(GAME);assert.equal(fromGuide.s.sent,0);
  const fromGame=rig(GAME);fromGame.altTab(GUIDE);assert.equal(fromGame.s.sent,0);
});
test('the switcher itself is not a landing',()=>{
  const {s,step,tap}=rig(GAME);
  step({});step({alt:true});step({front:SWITCHER});tap();step({alt:false});step({});
  assert.equal(s.sent,0);
  step({front:TERMINAL});assert.equal(s.sent,1);
});
test('with the guide closed, Alt+Tab from the game is left alone',()=>{
  const {s,altTab}=rig(GAME,false);
  altTab(TERMINAL);
  assert.equal(s.sent,0);assert.equal(s.front,TERMINAL);
});
test('with the guide closed, League\'s client still reaches the game past the Riot Client',()=>{
  const {s,step,tap}=rig(CLIENT,false);
  step({});step({alt:true});tap();step({alt:false});step({});assert.equal(s.sent,0,'still on the client just after the release');
  step({front:RIOT});assert.equal(s.sent,1);assert.equal(s.front,GAME);
});
test('League\'s client going to another program is left alone',()=>{
  const {s,altTab}=rig(CLIENT);
  altTab(TERMINAL);
  assert.equal(s.sent,0);
});
test('tabbing on to another window on purpose is left alone',()=>{
  const {s,step,tap}=rig(GUIDE);
  step({});step({alt:true});tap();tap();step({alt:false});step({front:TERMINAL});
  assert.equal(s.sent,0);assert.equal(s.front,TERMINAL);
  const fromGame=rig(GAME);
  fromGame.step({});fromGame.step({alt:true});fromGame.tap();fromGame.tap();fromGame.step({alt:false});fromGame.step({front:RIOT});
  assert.equal(fromGame.s.sent,0);
});
test('a window opened later by a click is not redirected',()=>{
  const {s,step,tap}=rig(GUIDE);
  step({});step({alt:true});tap();step({alt:false});step({});
  step({time:s.time+SETTLE+1});step({front:TERMINAL});
  assert.equal(s.sent,0);
});
