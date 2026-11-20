// A separate small process that alone freezes the League game, so no crash of Friloverse can
// leave it frozen: losing Friloverse (stdin closes), any error and a time limit all let it go.
// FrYiLoCo's launch guard (`launch_guard.rs`), which froze 60 of 60 games: it looks every 10 ms
// near the game's start, asks only for what a freeze needs, and a refusal is final, as no retry
// has ever won one. Runs under Electron as plain Node.
//   In, one word a line:  fast | slow | release | kill
//   Out, JSON lines:      ready | suspended {pid,created} | killed {pid} | gone {pid} |
//                         expired {pid} | released | blocked {pid,created,message} | failed {message}
const readline=require('node:readline');
const {listProcesses,openGame,openGameToEnd,gameCreated,processCreated,processExited,resumeGame,suspendGame,terminateGame,closeHandle,STATUS_ACCESS_DENIED}=require('./game-control.cjs');

const NAMES=new Set((process.env.FRILOVERSE_GUARD_NAMES||'league of legends.exe|league of legends (tm) client.exe').split('|'));
const LIMIT=Number(process.env.FRILOVERSE_GUARD_LIMIT)||50000;
// One look takes about 5 ms, so 10 ms is kept for when a game can actually start.
const SLOW=100,FAST=10;

// The limit runs from the first freeze. A restart (kill) once reset it, so League could be held
// for 50 s and then 50 s more; a game seen after a restart only gets what is left.
let every=SLOW,paused=null,timer=null,finished=false,firstFrozen=0;
const report=(event,details={})=>{try{process.stdout.write(`${JSON.stringify({event,...details})}\n`);}catch{/* Nobody is listening. */}};
const games=()=>listProcesses().filter(row=>NAMES.has(row.name));
const baseline=new Set(games().map(row=>row.pid));

function forget(game){
  closeHandle(game.handle);
  if(game.ender)closeHandle(game.ender);
}
function letGo(){
  if(!paused)return;
  const game=paused;paused=null;
  try{if(!processExited(game.handle))resumeGame(game.handle);}
  finally{forget(game);}
}
function finish(event,details,code=0){
  if(finished)return;
  finished=true;clearTimeout(timer);
  try{letGo();}catch(error){event='failed';details={message:error.message};code=1;}
  report(event,details);
  // The pipe may still hold the last line: leave once it has been written.
  process.stdout.write('',()=>process.exit(code));
  setTimeout(()=>process.exit(code),500).unref();
}
/** The only attempt at freezing a new game. A refusal is undone by suspendGame, so the game keeps starting. */
function hold(pid){
  let handle=null;
  try{
    handle=openGame(pid);
    if(!handle)return; // It has already ended.
    const created=processCreated(handle);
    suspendGame(handle);
    // Asked for separately, and never before the freeze: only a restart needs it.
    let ender=null;
    try{ender=openGameToEnd(pid);}catch{/* Asked again if a restart is ever wanted. */}
    firstFrozen||=Date.now();
    paused={pid,handle,ender,since:firstFrozen};
    report('suspended',{pid,created});
  }catch(error){
    if(handle)closeHandle(handle);
    if(!error.status)return finish('failed',{pid,message:error.message},1);
    // The game starts anyway. When it was created tells whether the freeze came too late.
    const denied=error.status===STATUS_ACCESS_DENIED;
    finish(denied?'blocked':'failed',{pid,created:gameCreated(pid),message:error.message},denied?0:1);
  }
}
function watch(){
  if(finished)return;
  try{
    if(paused){
      if(processExited(paused.handle)){
        const game=paused;paused=null;
        forget(game);
        report('gone',{pid:game.pid});
      }else if(Date.now()-paused.since>=LIMIT)return finish('expired',{pid:paused.pid});
    }else{
      for(const {pid} of games()){
        if(baseline.has(pid))continue;
        baseline.add(pid);
        hold(pid);
        break;
      }
    }
  }catch(error){return finish('failed',{message:error.message},1);}
  if(!finished)timer=setTimeout(watch,every);
}

const commands=readline.createInterface({input:process.stdin});
commands.on('line',line=>{
  const word=line.trim();
  if(word==='fast'||word==='slow'){every=word==='fast'?FAST:SLOW;clearTimeout(timer);watch();}
  else if(word==='release')finish('released');
  else if(word==='kill'&&paused){
    const game=paused;
    try{
      game.ender||=openGameToEnd(game.pid);
      if(game.ender)terminateGame(game.ender);
      paused=null;
      report('killed',{pid:game.pid});
      forget(game);
    }catch(error){finish('failed',{pid:game.pid,message:error.message},1);}
  }
});
// Friloverse is gone, however that happened.
commands.on('close',()=>finish('released'));
process.on('uncaughtException',error=>finish('failed',{message:error.message},1));
report('ready');
watch();
