import test from 'node:test';
import assert from 'node:assert/strict';
import {GameHold,startGuard,GRACE,FINAL_SELECTION_WAIT,FAST_WITHIN,CHOICE_LIMIT,HOLD_LIMIT,RECONNECT_NOTE} from '../src/game-hold.mjs';
import {randomUUID} from 'node:crypto';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {draftTimeLeft,readDraft} from '../src/league-client.mjs';

/** A hold with stand-ins, driven by hand: time only moves when a test moves it. */
function fixture({overlayOn=false,scan=0,patchAt=0}={}){
  const f={time:1000,sent:[],closed:0,started:0,reports:[],reconnects:0,waiting:[],settling:false,busy:false};
  f.engine={settled:true,overlayOn,patchAt,patchedAt:patchAt,holds:[],repatched:0,confirmed:true,confirmations:0,repatch(){this.repatched++;},patcherGone:false,async checkPatcher(){return this.patcherGone;},async confirmApplied(){this.confirmations++;return this.confirmed;},setHold(value){this.holds.push(value);}};
  f.party={report:state=>f.reports.push(state),choosing:()=>f.waiting,get settling(){return f.settling;}};
  f.scan=scan;
  f.hold=new GameHold({
    start:({onEvent})=>{f.started++;f.emit=onEvent;return {send:word=>f.sent.push(word),close:()=>{f.closed++;}};},
    engine:f.engine,party:f.party,reconnect:async()=>{f.reconnects++;},scanStart:async()=>f.scan,busy:()=>f.busy,
    now:()=>f.time,pause:async ms=>{f.time+=ms;},tick:60000,
  });
  // The timers are not what is under test.
  f.hold.schedule=()=>{};
  f.ahead=ms=>{f.time+=ms;};
  f.last=()=>f.reports.at(-1);
  f.end=()=>f.hold.dispose();
  return f;
}
function toGame(f,created=f.time+500){
  f.hold.observe('ChampSelect');
  f.hold.observe('GameStart');
  f.emit({event:'suspended',pid:7,created});
}

test('a guard launch refusal stays visible through game start and clears at match end',()=>{
  const f=fixture();f.hold.start=()=>{throw Error('EACCES');};
  f.hold.observe('ChampSelect');assert.match(f.hold.note,/could not start its game guard/);
  f.hold.observe('GameStart');assert.match(f.hold.note,/Skins may not load/);
  assert.equal(f.hold.open,false);f.hold.observe('Lobby');assert.equal(f.hold.note,'');f.end();
});
test('an unexpectedly closed guard warns even before the first freeze',()=>{
  const f=fixture();f.hold.observe('ChampSelect');f.emit({event:'closed'});
  assert.match(f.hold.note,/lost its game guard/);f.end();
});
test('an actual spawn failure reports a guard error before closing',async()=>{
  const events=[];
  await new Promise(resolve=>startGuard({execPath:path.join(tmpdir(),`missing-guard-${randomUUID()}.exe`),onEvent:event=>{events.push(event);if(event.event==='closed')resolve();}}));
  assert.deepEqual(events.map(event=>event.event),['failed','closed']);
  assert.match(events[0].message,/could not start its game guard/);
});

/** The player left the running game, and League shows its Reconnect button. */
function toReconnect(f){
  toGame(f);
  f.ahead(GRACE);f.hold.letGo();f.emit({event:'released'});f.emit({event:'closed'});
  f.hold.observe('InProgress');
  f.hold.observe('Reconnect',{gameGone:true});
}

test('leaving a running game opens choices again and asks for a fresh patch',()=>{
  const f=fixture();
  toReconnect(f);
  assert.equal(f.hold.reconnectWindow,true);
  assert.equal(f.hold.choicesOpen(),true);
  assert.equal(f.hold.open,true,'the engine may change skins');
  assert.equal(f.hold.frozen,false);
  assert.equal(f.hold.note,RECONNECT_NOTE);
  assert.equal(f.engine.repatched,1);
  assert.equal(f.started,2,'a new guard waits for the game coming back');
  assert.equal(f.last(),'prepared','friends never wait for a player coming back');
  f.hold.observe('Reconnect',{gameGone:true});
  assert.equal(f.started,2);assert.equal(f.engine.repatched,1);
  f.end();
});

test('the Reconnect screen says wait while a skin loads and safe once it is in',()=>{
  const f=fixture({overlayOn:true});
  assert.equal(f.hold.reconnectSafe(),null,'nothing to say outside the Reconnect screen');
  toReconnect(f);
  f.engine.settled=false;
  assert.equal(f.hold.reconnectSafe(),false,'the fresh patch is still running');
  f.engine.settled=true;
  assert.equal(f.hold.reconnectSafe(),true);
  f.busy=true;
  assert.equal(f.hold.reconnectSafe(),false,'a double click is being handled');
  f.busy=false;
  f.hold.observe('Reconnect',{gameGone:false});
  assert.equal(f.hold.reconnectSafe(),null,'the game is back');
  f.end();
});

test('a Reconnect phase with the game still running opens nothing',()=>{
  const f=fixture();
  toGame(f);f.ahead(GRACE);f.hold.letGo();f.emit({event:'released'});f.emit({event:'closed'});
  f.hold.observe('Reconnect',{gameGone:false});
  assert.equal(f.hold.reconnectWindow,false);
  assert.equal(f.hold.choicesOpen(),false);
  assert.equal(f.started,1);
  f.end();
});

test('Friloverse restarting a frozen game is not the player leaving',()=>{
  const f=fixture({overlayOn:true});
  toGame(f);
  f.emit({event:'killed',pid:7});
  f.hold.observe('Reconnect',{gameGone:true});
  assert.equal(f.hold.reconnectWindow,false);
  assert.equal(f.started,1);
  f.emit({event:'suspended',pid:8,created:f.time+1});
  f.end();
});

test('pressing Reconnect closes the choices, and a game that comes back early waits for the skin',async()=>{
  const f=fixture();
  toReconnect(f);
  f.engine.settled=false;
  f.hold.observe('Reconnect',{gameGone:false});
  assert.equal(f.hold.reconnectWindow,false);
  assert.equal(f.hold.choicesOpen(),false);
  assert.ok(f.sent.includes('fast'));
  assert.equal(f.hold.open,true,'still held until the guard has its answer');
  f.emit({event:'suspended',pid:9,created:f.time});
  assert.equal(f.hold.reason(),'League is waiting: getting skins ready… (50 s at most)');
  f.engine.settled=true;f.waiting=['Friend'];
  assert.equal(f.hold.reason(),'','and never for friends');
  await f.hold.step();
  assert.ok(f.sent.includes('release'));
  f.end();
});

test('the match ending from the Reconnect screen closes everything',()=>{
  const f=fixture();
  toReconnect(f);
  f.hold.observe('EndOfGame');
  assert.equal(f.hold.reconnectWindow,false);
  assert.equal(f.hold.choicesOpen(),false);
  assert.equal(f.hold.note,'');
  f.end();
});

test('an old guard closing never takes the new one with it',()=>{
  const f=fixture();
  f.hold.observe('ChampSelect');
  const old=f.emit;
  f.hold.observe('Lobby');f.hold.observe('ChampSelect');
  old({event:'closed'});
  assert.ok(f.hold.guard,'the new guard stays');
  f.end();
});

test('the guard starts with the draft, once, and goes when the match never starts',()=>{
  const f=fixture();
  f.hold.observe('Lobby');assert.equal(f.started,0);
  f.hold.observe('ChampSelect');f.hold.observe('ChampSelect');assert.equal(f.started,1);
  f.hold.observe('Lobby');assert.equal(f.closed,1);
  f.hold.observe('ChampSelect');assert.equal(f.started,2);
  f.end();
});

test('a guard that cannot run is not started again and again during the draft',()=>{
  const f=fixture();
  f.hold.observe('ChampSelect');
  f.emit({event:'failed',message:'no'});f.emit({event:'closed'});
  f.hold.observe('ChampSelect');f.hold.observe('ChampSelect');
  assert.equal(f.started,1);
  assert.equal(f.hold.open,false);
  f.end();
});

test('choices close after a short settle once champion select ends',()=>{
  assert.equal(GRACE,300);
  const f=fixture();
  f.hold.observe('ChampSelect');assert.equal(f.hold.choicesOpen(),true);
  f.hold.observe('GameStart');
  assert.ok(f.sent.includes('fast'));
  assert.equal(f.hold.choicesOpen(),true);
  f.ahead(GRACE-1);assert.equal(f.hold.choicesOpen(),true);
  f.ahead(1);assert.equal(f.hold.choicesOpen(),false);
  f.end();
});

test('a game seen before League\'s phase changed still gets the whole grace period',()=>{
  const f=fixture();
  f.hold.observe('ChampSelect');
  f.emit({event:'suspended',pid:7,created:f.time});
  f.hold.phase='GameStart';
  assert.equal(f.hold.choicesOpen(),true);
  f.ahead(GRACE);assert.equal(f.hold.choicesOpen(),false);
  f.end();
});

test('a game frozen inside the settle that began with the phase gets a whole settle of its own',async()=>{
  const f=fixture();
  f.hold.observe('ChampSelect');f.hold.observe('GameStart');
  f.ahead(GRACE-100);
  f.emit({event:'suspended',pid:7,created:f.time});
  f.ahead(GRACE-1);await f.hold.step();
  assert.ok(!f.sent.includes('release'),'the whole settle from the freeze, not from the phase');
  assert.equal(f.hold.choicesOpen(),true);
  f.ahead(1);await f.hold.step();
  assert.ok(f.sent.includes('release'));
  f.end();
});

test('a game that appears after the choices were final does not open them again',async()=>{
  const f=fixture();
  f.hold.observe('ChampSelect');f.hold.observe('GameStart');
  f.ahead(GRACE);assert.equal(f.hold.sealed,true);
  f.ahead(700);f.emit({event:'suspended',pid:7,created:f.time});
  assert.equal(f.hold.sealed,true,'the engine may already be patching what was final');
  assert.equal(f.hold.choicesOpen(),false);
  assert.equal(f.last(),'prepared','friends are not made to wait again');
  await f.hold.step();
  assert.ok(f.sent.includes('release'),'no second settle');
  f.end();
});

test('League saying the draft is over after the freeze does not start the settle again',async()=>{
  const f=fixture();f.engine.status='ready';
  f.hold.observe('ChampSelect');
  f.emit({event:'suspended',pid:7,created:f.time});
  assert.equal(f.last(),'armed');
  f.ahead(GRACE);f.hold.sync();
  assert.equal(f.hold.sealed,true);
  assert.equal(f.hold.choicesOpen(),false,'the freeze counts, whatever the client still says');
  assert.equal(f.last(),'prepared','friends stop waiting although the client still says champion select');
  // The client catches up 0.2 to 0.7 s later in real matches.
  f.ahead(400);f.hold.observe('GameStart');
  assert.equal(f.hold.sealed,true);
  assert.equal(f.hold.choicesOpen(),false);
  await f.hold.step();
  assert.ok(f.sent.includes('release'));
  f.end();
});

test('League is not released until the skin is confirmed in the overlay',async()=>{
  const f=fixture();toGame(f);f.engine.confirmed=false;
  f.ahead(GRACE);await f.hold.step();
  assert.equal(f.engine.confirmations,1);
  assert.ok(!f.sent.includes('release'),'the engine is patching again');
  f.engine.confirmed=true;await f.hold.step();
  assert.ok(f.sent.includes('release'));
  f.end();
});

test('a patched game briefly waits for the final League selection if the draft phase lags',async()=>{
  for(const movesOn of [true,false]){
    const f=fixture({overlayOn:true,scan:900,patchAt:900});
    f.hold.observe('ChampSelect');
    f.emit({event:'suspended',pid:7,created:f.time});
    f.ahead(GRACE);await f.hold.step();
    assert.equal(f.hold.choicesOpen(),false);
    assert.match(f.hold.note,/final skin selection/);
    assert.ok(!f.sent.includes('release'));
    if(movesOn)f.hold.observe('GameStart');
    else f.ahead(FINAL_SELECTION_WAIT-GRACE);
    await f.hold.step();
    assert.ok(f.sent.includes('release'));
    f.end();
  }
});

test('with nothing to wait for the game is released when the grace period ends',async()=>{
  const f=fixture();toGame(f);
  await f.hold.step();
  assert.ok(!f.sent.includes('release'),'still inside the grace period');
  assert.match(f.hold.note,/getting skins ready/);
  f.ahead(GRACE);await f.hold.step();
  assert.ok(f.sent.includes('release'));
  assert.equal(f.hold.open,false);
  assert.equal(f.reconnects,0);
  f.end();
});

test('the game waits for the engine, for a pick being read and for a friend\'s skin',async()=>{
  for(const [block,stage] of [[f=>{f.engine.settled=false;},'preparing'],[f=>{f.busy=true;},'preparing'],[f=>{f.settling=true;},'syncing']]){
    const f=fixture();toGame(f);block(f);
    f.ahead(GRACE);await f.hold.step();
    assert.ok(!f.sent.includes('release'));
    assert.match(f.hold.note,/getting skins ready/);
    assert.equal(f.last(),stage,'the party is told this PC is not ready');
    f.engine.settled=true;f.busy=false;f.settling=false;
    await f.hold.step();
    assert.ok(f.sent.includes('release'));
    f.end();
  }
});

test('a friend still choosing holds the game briefly, once this PC has every skin in',async()=>{
  const f=fixture();toGame(f);f.waiting=['Sam','Alex'];
  f.ahead(GRACE);await f.hold.step();
  assert.equal(f.last(),'prepared','this PC is ready');
  assert.ok(!f.sent.includes('release'));
  assert.match(f.hold.note,/waiting for Sam, Alex to finish choosing/);
  f.waiting=['Alex'];await f.hold.step();assert.ok(!f.sent.includes('release'));
  f.waiting=[];await f.hold.step();assert.ok(f.sent.includes('release'));
  f.end();
});

test('a friend still choosing never holds the game past the choice limit',async()=>{
  assert.ok(CHOICE_LIMIT<=10000,'only a few seconds, never the old 24 s');
  const f=fixture();toGame(f);f.waiting=['Sam'];
  f.ahead(CHOICE_LIMIT-1);await f.hold.step();assert.ok(!f.sent.includes('release'));
  f.ahead(1);await f.hold.step();assert.ok(f.sent.includes('release'));
  f.end();
});

test('a friend whose PC is still preparing never holds this game',async()=>{
  // The party says who is still choosing; a friend preparing has chosen, so is not in that list.
  const f=fixture();toGame(f);f.waiting=[];
  f.ahead(GRACE);await f.hold.step();
  assert.ok(f.sent.includes('release'),'this PC has every party skin in, so its game goes');
  f.end();
});

test('a restart happens as soon as the skins are in, not after waiting on friends',async()=>{
  const f=fixture({overlayOn:true,patchAt:1600,scan:1700});
  toGame(f,1500);f.waiting=['Sam'];
  f.ahead(GRACE);await f.hold.step();
  assert.ok(f.sent.includes('kill'),'restarted at once');
  f.end();
});

test('the skin checks run once per patch, not on every look while a friend chooses',async()=>{
  const f=fixture({overlayOn:true,patchAt:900,scan:950});
  let scans=0;f.hold.scanStart=async()=>{scans++;return 950;};
  toGame(f,1500);f.waiting=['Sam'];
  f.ahead(GRACE);
  for(let i=0;i<5;i++){await f.hold.step();f.ahead(100);}
  assert.equal(f.engine.confirmations,1);assert.equal(scans,1);
  // A new patch (a friend's skin arriving) is checked again.
  f.engine.patchAt=f.engine.patchedAt=1800;f.hold.scanStart=async()=>{scans++;return 1900;};
  await f.hold.step();
  assert.equal(f.engine.confirmations,2);
  f.end();
});

test('a PC that is not ready says how long League may still wait',async()=>{
  assert.equal(HOLD_LIMIT,50000);
  const f=fixture();toGame(f);f.engine.settled=false;
  f.ahead(GRACE);await f.hold.step();
  assert.match(f.hold.note,/getting skins ready… \(50 s at most\)/);
  f.end();
});

test('what this PC tells the party: nobody waits on someone outside a match',()=>{
  const f=fixture();
  f.hold.observe('Lobby');assert.equal(f.last(),'prepared');
  f.hold.observe('ChampSelect');assert.equal(f.last(),'selected');
  f.hold.observe('GameStart');assert.equal(f.last(),'selected');
  f.ahead(GRACE);f.hold.sync();assert.equal(f.last(),'prepared');
  f.hold.observe('Lobby');assert.equal(f.last(),'prepared');
  f.end();
});

test('the stages a lobby shows: applying, ready while choosing, then finished',async()=>{
  const f=fixture();
  f.hold.observe('ChampSelect');assert.equal(f.last(),'selected');
  f.engine.settled=false;f.engine.status='applying';f.hold.sync();assert.equal(f.last(),'preparing');
  f.engine.settled=true;f.engine.status='ready';f.hold.sync();assert.equal(f.last(),'armed','ready, and may still change');
  f.engine.status='failed';f.hold.sync();assert.equal(f.last(),'error');
  f.engine.status='ready';
  f.hold.observe('GameStart');f.emit({event:'suspended',pid:7,created:f.time});
  assert.equal(f.last(),'armed','the grace period is still running');
  f.ahead(GRACE);f.hold.sync();assert.equal(f.last(),'prepared');
  f.party.missing=[{champion:'zed',name:'Zed skin'}];f.hold.sync();assert.equal(f.last(),'partial');
  await f.hold.step();f.emit({event:'released'});
  assert.equal(f.last(),'active');
  f.end();
});

test('a game created under LTK\'s scan is simply released',async()=>{
  const f=fixture({overlayOn:true,patchAt:900,scan:950});
  toGame(f,1500);
  f.ahead(GRACE);await f.hold.step();
  assert.ok(f.sent.includes('release'));
  assert.ok(!f.sent.includes('kill'));
  f.end();
});

test('a late skin restarts the game: ended, reconnected, and released under the scan',async()=>{
  const f=fixture({overlayOn:true,patchAt:1250,scan:1280});
  toGame(f,1100);
  f.ahead(GRACE);await f.hold.step();
  assert.ok(f.sent.includes('kill'));
  assert.ok(!f.sent.includes('release'));
  assert.match(f.hold.note,/Starting League again/);
  // Keep the reconnect loop to one pass: the new game shows up during it.
  const coming=new Promise(done=>{
    f.hold.reconnect=async()=>{f.reconnects++;f.emit({event:'suspended',pid:8,created:f.time});done();};
  });
  f.emit({event:'killed',pid:7});
  assert.equal(f.hold.frozen,true,'the engine may still change skins meanwhile');
  await coming;
  assert.equal(f.reconnects,1);
  assert.equal(f.hold.choicesOpen(),false,'the restart does not open a new grace period');
  await f.hold.step();
  assert.ok(f.sent.includes('release'));
  assert.equal(f.sent.filter(word=>word==='kill').length,1);
  f.end();
});

test('the reconnect waits first, and not at all once the restart is over',async()=>{
  const f=fixture({overlayOn:true,patchAt:1600,scan:1700});
  toGame(f,1500);
  f.ahead(GRACE);await f.hold.step();
  let resume;
  const paused=new Promise(done=>{f.hold.pause=async()=>{done();await new Promise(go=>{resume=go;});};});
  f.emit({event:'killed',pid:7});
  await paused;
  assert.equal(f.reconnects,0,'the client is not asked in the moment after the kill');
  f.hold.restarting=false;resume();
  await new Promise(setImmediate);
  assert.equal(f.reconnects,0);
  f.end();
});

test('a refused reconnect is asked again soon, and an accepted one gets a second to show its game',async()=>{
  const f=fixture({overlayOn:true,patchAt:1600,scan:1700}),asked=[],lines=[];
  f.hold.log=line=>lines.push(line);
  toGame(f,1500);
  f.ahead(GRACE);await f.hold.step();
  const killedAt=f.time;
  const back=new Promise(done=>{
    f.hold.reconnect=async()=>{
      asked.push(f.time-killedAt);
      // League's client says no until it has noticed its game is gone.
      if(asked.length<=2)throw new Error('League endpoint unavailable');
      if(asked.length===4){f.emit({event:'suspended',pid:8,created:f.time});done();}
    };
  });
  f.emit({event:'killed',pid:7});
  await back;await new Promise(setImmediate);
  assert.deepEqual(asked,[250,500,750,1750]);
  assert.equal(lines.filter(line=>line.startsWith('reconnect:')).length,1,'a run of refusals is one line');
  assert.ok(lines.some(line=>/took the reconnect 750 ms after the game was ended \(2 refused before\)/.test(line)));
  assert.equal(f.hold.restarting,false);
  f.end();
});

test('LTK\'s log being behind is not mistaken for an old scan',async()=>{
  const f=fixture({overlayOn:true,patchAt:1600,scan:100});
  f.engine.patchedAt=1650;
  toGame(f,1500);
  f.ahead(GRACE);await f.hold.step();
  assert.ok(f.sent.includes('kill'));
  f.end();
});

test('restarts are limited: the third early game opens with a warning that survives release',async()=>{
  const f=fixture({overlayOn:true,patchAt:1600,scan:99999});
  f.hold.bringBack=async()=>{};
  toGame(f,1500);
  f.ahead(GRACE);
  for(let round=0;round<2;round++){
    await f.hold.step();
    assert.equal(f.sent.filter(word=>word==='kill').length,round+1);
    f.emit({event:'killed',pid:7});
    f.emit({event:'suspended',pid:8+round,created:1500});
  }
  await f.hold.step();
  assert.equal(f.sent.filter(word=>word==='kill').length,2);
  assert.ok(f.sent.includes('release'));
  assert.match(f.hold.note,/two restart attempts.*skins could not load/);
  f.emit({event:'released'});f.emit({event:'closed'});
  assert.match(f.hold.note,/skins could not load for this match/);
  f.end();
});

test('using both restarts does not warn if the returning game was created under the scan',async()=>{
  const f=fixture({overlayOn:true,patchAt:1600,scan:1600});
  toGame(f,2000);f.hold.restarts=2;f.ahead(GRACE);await f.hold.step();
  assert.ok(f.sent.includes('release'));assert.equal(f.hold.note,'');f.end();
});

test('a game that never comes back is handed to the player',async()=>{
  const f=fixture({overlayOn:true,patchAt:1600,scan:1700});
  toGame(f,1500);
  f.ahead(GRACE);await f.hold.step();
  f.emit({event:'killed',pid:7});
  await new Promise(done=>setTimeout(done,10));
  assert.equal(f.hold.restarting,false);
  assert.equal(f.hold.released,true);
  assert.match(f.hold.note,/Reconnect button/);
  assert.equal(f.hold.partyState(),'active','nobody waits on a game handed to the player');
  f.end();
});

test('the guard\'s own limit and failures end the hold, and the player is told',()=>{
  for(const [report,expected] of [[{event:'expired',pid:7},/could not wait/],[{event:'failed',message:'League could not be reached.'},/could not be reached/]]){
    const f=fixture();toGame(f);
    f.emit(report);
    assert.equal(f.hold.open,false);
    assert.equal(f.hold.frozen,false);
    assert.match(f.hold.note,expected);
    assert.equal(f.hold.partyState(),'active');
    f.end();
  }
});

test('a game Windows will not let Friloverse freeze is simply opened, in plain words',()=>{
  const f=fixture();toGame(f);
  f.emit({event:'blocked',pid:7,message:'Could not hold League (NTSTATUS c0000022).'});
  assert.equal(f.hold.open,false);
  assert.equal(f.hold.frozen,false);
  assert.doesNotMatch(f.hold.note,/NTSTATUS/);
  assert.match(f.hold.note,/could not load for this match/);
  assert.equal(f.hold.partyState(),'active','nobody is held back by it');
  f.end();
});

test('a Windows code never reaches the player',()=>{
  const f=fixture();toGame(f);
  f.emit({event:'failed',message:'Could not release League (NTSTATUS c0000022).'});
  assert.doesNotMatch(f.hold.note,/NTSTATUS/);
  assert.match(f.hold.note,/close it from League/);
  f.end();
});

test('a guard that dies unasked is noticed',()=>{
  const f=fixture();toGame(f);
  f.emit({event:'closed'});
  assert.equal(f.hold.open,false);
  assert.match(f.hold.note,/lost its game guard/);
  f.end();
});

test('quitting Friloverse lets the game go',()=>{
  const f=fixture();toGame(f);
  f.hold.dispose();
  assert.equal(f.closed,1);
  assert.deepEqual(f.engine.holds.at(-1),{open:false,frozen:false,sealed:false});
});

test('the engine is told whether it may change skins under a frozen game',async()=>{
  const f=fixture();
  f.hold.observe('ChampSelect');assert.deepEqual(f.engine.holds.at(-1),{open:false,frozen:false,sealed:false});
  f.hold.observe('GameStart');assert.deepEqual(f.engine.holds.at(-1),{open:true,frozen:false,sealed:false});
  f.emit({event:'suspended',pid:7,created:f.time});assert.deepEqual(f.engine.holds.at(-1),{open:true,frozen:true,sealed:false});
  f.ahead(GRACE);await f.hold.step();assert.deepEqual(f.engine.holds.at(-1),{open:false,frozen:false,sealed:false});
  f.end();
});

test('the choices become final when the grace period ends, before League may go',async()=>{
  const f=fixture();toGame(f);
  assert.equal(f.hold.sealed,false);
  f.ahead(GRACE-1);f.hold.sync();assert.equal(f.engine.holds.at(-1).sealed,false);
  f.ahead(1);
  // A real engine stops being settled the moment it hears, so League waits for the patch.
  const setHold=f.engine.setHold;
  f.engine.setHold=function(value){setHold.call(this,value);if(value.sealed&&!this.patched)this.settled=false;};
  await f.hold.step();
  assert.equal(f.engine.holds.at(-1).sealed,true);
  assert.ok(!f.sent.includes('release'),'never let go between the seal and the patch');
  assert.match(f.hold.note,/getting skins ready/);
  f.engine.patched=true;f.engine.settled=true;await f.hold.step();
  assert.ok(f.sent.includes('release'));
  f.end();
});

test('a game frozen while League still says champion select is sealed all the same',()=>{
  const f=fixture();
  f.hold.observe('ChampSelect');
  f.emit({event:'suspended',pid:7,created:f.time});
  f.ahead(GRACE);
  assert.equal(f.hold.sealed,true);
  f.end();
});

test('no game yet when the grace period ends: patched anyway, and that game needs no restart',async()=>{
  const f=fixture({overlayOn:true,patchAt:3000,scan:3100});
  f.hold.observe('ChampSelect');f.hold.observe('GameStart');
  f.ahead(GRACE);assert.equal(f.hold.sealed,true);
  f.time=4000;f.emit({event:'suspended',pid:7,created:4000});
  f.ahead(GRACE);await f.hold.step();
  assert.ok(f.sent.includes('release'));
  assert.ok(!f.sent.includes('kill'));
  f.end();
});

test('a restart does not wait for a friend choosing all over again',async()=>{
  const f=fixture();toGame(f);f.waiting=['Sam'];
  // The stand-in pause moves the clock when called; here the clock must only move by hand.
  f.hold.pause=async()=>{};
  f.ahead(CHOICE_LIMIT-1000);f.emit({event:'killed',pid:7});f.hold.restarting=false;
  f.emit({event:'suspended',pid:8,created:f.time});
  f.ahead(999);await f.hold.step();assert.ok(!f.sent.includes('release'));
  f.ahead(1);await f.hold.step();assert.ok(f.sent.includes('release'));
  f.end();
});

test('the guard looks at its fastest only when a game could start',()=>{
  const f=fixture();
  const words=()=>f.sent.filter(word=>word==='fast'||word==='slow');
  f.hold.observe('ChampSelect');
  f.hold.setTimeLeft(30000);assert.deepEqual(words(),[],'it starts slow');
  f.hold.setTimeLeft(FAST_WITHIN);assert.deepEqual(words(),['fast']);
  f.hold.setTimeLeft(9000);assert.deepEqual(words(),['fast'],'told once');
  f.hold.setTimeLeft(25000);assert.deepEqual(words(),['fast','slow'],'a new turn of the draft');
  f.hold.setTimeLeft(null);assert.deepEqual(words(),['fast','slow','fast'],'a clock that promises nothing is treated as now');
  f.end();
});

test('a late reading of the clock cannot slow the guard once the draft is over',()=>{
  const f=fixture();
  f.hold.observe('ChampSelect');f.hold.observe('GameStart');
  f.sent.length=0;f.hold.setTimeLeft(60000);
  assert.deepEqual(f.sent,[]);
  f.end();
});

test('waiting at the Reconnect screen keeps the guard at its fastest',()=>{
  const f=fixture();toReconnect(f);
  assert.equal(f.hold.pace,'fast');
  assert.equal(f.sent.at(-1),'fast');
  f.end();
});

test('the draft\'s clock: its age is taken off, and no clock promises nothing',async()=>{
  assert.equal(draftTimeLeft({timer:{adjustedTimeLeftInPhase:30000,internalNowInEpochMs:1000}},1500),29500);
  assert.equal(draftTimeLeft({timer:{adjustedTimeLeftInPhase:300,internalNowInEpochMs:1000}},1500),0);
  assert.equal(draftTimeLeft({timer:{adjustedTimeLeftInPhase:30000,internalNowInEpochMs:1000}},900),30000,'a reading from the future has no age');
  assert.equal(draftTimeLeft({timer:{adjustedTimeLeftInPhase:30000}},1500),30000);
  assert.equal(draftTimeLeft({timer:{adjustedTimeLeftInPhase:30000,isInfinite:true}},0),null);
  assert.equal(draftTimeLeft({timer:{adjustedTimeLeftInPhase:30000,isPaused:true}},0),null);
  assert.equal(draftTimeLeft({},0),null);
  const {slots,left}=await readDraft({connect:async()=>({}),now:()=>0,get:async()=>({timer:{adjustedTimeLeftInPhase:5000},myTeam:[{championId:103,selectedSkinId:103066}]})});
  assert.equal(left,5000);assert.equal(slots.get(103),66);
});
