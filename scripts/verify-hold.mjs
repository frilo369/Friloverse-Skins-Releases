// The real guard process on a real program: a copy of Windows' ping under another name, so
// League is never touched. Checks freezing, releasing, ending, the time limit, an existing
// program being left alone, and Friloverse crashing while it holds. `--exe=<Friloverse-Skins.exe>`
// runs the guard the way a packaged build does. Safe at any time.
import {spawn} from 'node:child_process';
import {copyFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {GameHold,GRACE,startGuard} from '../src/game-hold.mjs';

const require=createRequire(import.meta.url);
const {listProcesses}=require('../src/game-control.cjs');
const packaged=process.argv.find(arg=>arg.startsWith('--exe='))?.slice(6);
const NAME='friloverse-guard-probe.exe';
const dir=await mkdtemp(path.join(tmpdir(),'friloverse-hold-')),probe=path.join(dir,NAME);
await copyFile(path.join(process.env.SystemRoot,'System32','PING.EXE'),probe);
const pause=ms=>new Promise(done=>setTimeout(done,ms));
const fails=[];
const check=(ok,what)=>{console.log(`${ok?'ok  ':'FAIL'} ${what}`);if(!ok)fails.push(what);};
const options=packaged?{execPath:packaged,script:path.join(path.dirname(packaged),'resources','app','src','game-guard.cjs')}:{};

// Ping waits a second between tries, so `-n 3` ends after about 2 s: a frozen one does not end.
function runProbe(tries=3){
  const child=spawn(probe,['-n',String(tries),'127.0.0.1'],{stdio:'ignore',windowsHide:true});
  child.done=false;
  child.ended=new Promise(done=>child.on('close',()=>{child.done=true;done();}));
  return child;
}
const endsWithin=(child,ms)=>Promise.race([child.ended.then(()=>true),pause(ms).then(()=>false)]);
function guard(env={},extra={}){
  const events=[];let waiters=[];
  const handle=(extra.start||startGuard)({...options,env:{FRILOVERSE_GUARD_NAMES:NAME,...env},onEvent:event=>{events.push(event);waiters=waiters.filter(wake=>!wake(event));}});
  handle.until=(name,ms=8000)=>{
    const seen=events.find(event=>event.event===name);
    if(seen)return Promise.resolve(seen);
    return new Promise((done,fail)=>{
      const timer=setTimeout(()=>fail(new Error(`no "${name}" in ${ms} ms; saw ${events.map(event=>event.event).join(', ')||'nothing'}`)),ms);
      waiters.push(event=>{if(event.event!==name)return false;clearTimeout(timer);done(event);return true;});
    });
  };
  handle.events=events;
  return handle;
}
const running=()=>listProcesses().some(row=>row.name===NAME);

try{
  {
    const before=runProbe();await pause(300);
    const g=guard();await g.until('ready');
    const after=runProbe();
    const begun=Date.now(),held=await g.until('suspended');
    console.log(`     frozen ${Date.now()-begun} ms after it started`);
    check(held.pid===after.pid,'only the new program is frozen, not one already running');
    check(Math.abs(held.created-begun)<3000,'its start time is read correctly');
    check(await endsWithin(before,6000),'the program already running keeps going');
    await pause(2000);
    check(!after.done,'a frozen program does nothing');
    g.send('release');await g.until('released');
    check(await endsWithin(after,6000),'released, it carries on');
  }
  {
    const g=guard();await g.until('ready');g.send('fast');
    const first=runProbe(60);await g.until('suspended');
    g.send('kill');const killed=await g.until('killed');
    check(killed.pid===first.pid,'kill ends the frozen program');
    await first.ended;
    g.events.length=0;
    const second=runProbe();
    const again=await g.until('suspended');
    check(again.pid===second.pid,'the program started next is frozen too');
    g.send('release');await g.until('released');
    await second.ended;
  }
  {
    const g=guard({FRILOVERSE_GUARD_LIMIT:'3500'});await g.until('ready');g.send('fast');
    const game=runProbe();await g.until('suspended');
    await pause(3000);
    check(!game.done,'still frozen before the time limit');
    await g.until('expired');
    check(await endsWithin(game,6000),'the time limit lets it go by itself');
  }
  {
    // A restart does not start the limit again: it runs from the first freeze.
    const g=guard({FRILOVERSE_GUARD_LIMIT:'4000'});await g.until('ready');g.send('fast');
    const first=runProbe(60);await g.until('suspended');
    await pause(2500);
    g.send('kill');await g.until('killed');await first.ended;
    const second=runProbe();const frozen=Date.now();await g.until('suspended');
    await g.until('expired');
    const held=Date.now()-frozen;
    console.log(`     after a restart the new game was held ${held} ms`);
    check(held<2500,'after a restart only what is left of the limit remains');
    check(await endsWithin(second,6000),'and then it goes');
  }
  {
    // Friloverse crashing: everything it held dies with it, so the guard's input closes.
    const g=guard();await g.until('ready');g.send('fast');
    const game=runProbe();await g.until('suspended');
    await pause(3000);
    check(!game.done,'still frozen while Friloverse runs');
    g.close();await g.until('released');
    check(await endsWithin(game,6000),'losing Friloverse lets it go');
  }
  {
    // The whole hold with its real timers, in a party of one friend still choosing.
    const reports=[];let friends=['Sam'],note='';
    const engine={settled:true,overlayOn:false,patchedAt:0,setHold(){},async checkPatcher(){return false;},async confirmApplied(){return true;}};
    const party={settling:false,report:state=>reports.push(state),choosing:()=>friends};
    const hold=new GameHold({engine,party,reconnect:async()=>{},scanStart:async()=>0,onChange:()=>{note=hold.note;},
      start:({onEvent})=>startGuard({...options,env:{FRILOVERSE_GUARD_NAMES:NAME},onEvent})});
    hold.observe('ChampSelect');
    await pause(1500);
    const ended=Date.now();
    const game=runProbe();
    // The settle is short, so look the moment the guard has frozen the game.
    for(let i=0;i<300&&!hold.held;i++)await pause(10);
    check(hold.choicesOpen()&&!!hold.held,'right after the freeze the game is held and choices are still open');
    await pause(GRACE+100);
    check(!hold.choicesOpen()&&hold.sealed,'choices close after the settle, although League still says champion select');
    check(reports.at(-1)==='prepared','and the party already hears this PC is ready');
    // League's client says the draft is over a moment after the game exists, as in real matches.
    hold.observe('GameStart');
    await pause(600);
    check(!hold.choicesOpen(),'hearing it late does not open the choices again');
    check(!game.done&&/waiting for Sam to finish choosing/.test(note),'it waits for the friend still choosing');
    check(reports.at(-1)==='prepared','this PC tells the party it is ready');
    await pause(1500);
    check(!game.done,'still frozen');
    friends=[];
    check(await endsWithin(game,6000),'once the friend has chosen, it opens');
    console.log(`     the game opened ${Date.now()-ended} ms after champion select ended`);
    hold.observe('Lobby');hold.dispose();
  }
  {
    const begun=process.hrtime.bigint();
    for(let i=0;i<50;i++)listProcesses();
    console.log(`     one look at the process list: ${Number((process.hrtime.bigint()-begun)/50n)/1e6} ms, with ${listProcesses().length} processes`);
  }
  check(!running(),'nothing is left running');
}catch(error){check(false,error.message);}
finally{
  for(const row of listProcesses())if(row.name===NAME)try{process.kill(row.pid);}catch{}
  await pause(200);
  if(path.dirname(path.resolve(dir))!==path.resolve(tmpdir()))throw new Error('Refusing cleanup outside the temporary folder.');
  await rm(dir,{recursive:true,force:true}).catch(()=>{});
}
console.log(fails.length?`${fails.length} check(s) failed.`:'All checks passed.');
process.exitCode=fails.length?1:0;
