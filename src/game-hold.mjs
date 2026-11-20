import {spawn} from 'node:child_process';
import path from 'node:path';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';

// A short settle after the game is first frozen (or League's client says the draft is over,
// whichever is seen first): then the choices are final. It was 2 s for last-moment picks (4.7),
// but since 9.1 the panel hides at the first freeze, so nobody could pick in it and League only
// waited (owner's request, 2026-11-11). What is still on its way is waited for by name instead:
// this PC's own click (`busy`, `engine.settled`) and a friend still choosing (`CHOICE_LIMIT`).
export const GRACE=300;
// The guard looks at its fastest once a game could start this soon (FrYiLoCo's window).
export const FAST_WITHIN=12000;
// Each PC's game goes once that PC has every party skin in (owner's decision, 2026-11-08): a
// friend's PC still preparing never holds anyone back. Only a friend still choosing in the grace
// period is waited for, this long at most from the first freeze, so a last-moment pick is not missed.
export const CHOICE_LIMIT=8000;
// The guard's own limit, from the first freeze and through restarts: a PC that is not ready
// holds League this long at most (game-guard.cjs, FRILOVERSE_GUARD_LIMIT).
export const HOLD_LIMIT=50000;
const MAX_RESTARTS=2,RECONNECT_WAIT=20000,TICK=50,SCAN_LOG_WAIT=1000,NO_GAME_LIMIT=30000;
// The client can still report ChampSelect for several hundred milliseconds after the game exists.
export const FINAL_SELECTION_WAIT=1000;
// Asking League's client to start the game again. Right after the kill it always says no (30 of
// 30 in real matches), and one second later it said yes every time; when in between it starts
// saying yes is not known, so a no is asked again soon. A yes gets the old full second to show
// its game before it is asked again.
const RECONNECT_ASK=250,RECONNECT_SHOW=1000;
const MATCH=new Set(['GameStart','InProgress','Reconnect']);
export const RECONNECT_NOTE='Your game is still on. Double-click a skin, then press Reconnect in League when it says ready.';
const GUARD=path.join(path.dirname(fileURLToPath(import.meta.url)),'game-guard.cjs');
const wait=ms=>new Promise(done=>setTimeout(done,ms));

/** A Windows refusal in plain words; the code itself stays in Friloverse's own log. */
export function plainHoldError(message){
  const text=String(message||'');
  return /NTSTATUS/i.test(text)?'Windows would not let Friloverse hold or release League. If the game is stuck, close it from League and reconnect.':text;
}

/** The guard process: `onEvent` gets its reports and `{event:'closed'}` when it is gone. */
export function startGuard({onEvent,execPath=process.execPath,script=GUARD,env={}}){
  const child=spawn(execPath,[script],{env:{...process.env,ELECTRON_RUN_AS_NODE:'1',...env},stdio:['pipe','pipe','ignore'],windowsHide:true});
  const lines=createInterface({input:child.stdout});
  lines.on('line',line=>{try{onEvent(JSON.parse(line));}catch{/* Not a report. */}});
  let closed=false;
  const close=()=>{if(!closed){closed=true;onEvent({event:'closed'});}};
  child.on('error',error=>{onEvent({event:'failed',message:`Friloverse could not start its game guard (${error.code||'launch error'}). Skins may not load for this match.`});close();});child.on('close',close);
  child.stdin.on('error',()=>{});
  return {
    send:word=>{if(!child.stdin.destroyed)child.stdin.write(`${word}\n`);},
    close:()=>{child.stdin.end();},
  };
}

/**
 * Keeps League from opening until skins are in place. A guard process freezes the game as it
 * is created; this decides when it may go: after a short settle the choices are final and the
 * engine patches whatever its patcher does not hold yet (`sealed`), and the game goes once every party skin is in
 * on this PC (no friend's own preparation is waited for), or at the guard's 50 s limit. LTK Manager only reaches a game created after
 * its scan began, so a game frozen before the patch is started again: the frozen one is ended
 * and League's client reconnects to the match (Rose's way). A game created after it is just
 * released (FrYiLoCo's way), which is the usual case now that the engine starts the patcher
 * during the draft. Every wait has a limit.
 */
export class GameHold{
  constructor({start=startGuard,engine,party,reconnect,scanStart,busy=()=>false,onChange=()=>{},log=()=>{},now=Date.now,pause=wait,tick=TICK}){
    Object.assign(this,{start,engine,party,reconnect,scanStart,busy,onChange,log,now,pause,tick});
    this.guard=null;this.phase='';this.closesAt=0;this.released=false;this.held=null;
    this.restarts=0;this.restarting=false;this.restartSince=0;this.deciding=false;this.note='';
    this.timer=null;this.disposed=false;this.gaveUp=false;
    // The player left a running match: until the game comes back, skins may change again.
    this.reconnectWindow=false;this.fromReconnect=false;this.swiftplaySearching=false;this.guardRun=0;this.pace='slow';
  }
  /** League's game is being held back, or may still be, so the overlay may still change. */
  get open(){return this.reconnectWindow||!!this.guard&&!this.released&&MATCH.has(this.phase);}
  get frozen(){return !!this.held||this.restarting;}
  /** The choices are final: time to patch everything at once. */
  get sealed(){
    if(this.reconnectWindow)return true;
    const holding=!!this.guard&&!this.released&&(MATCH.has(this.phase)||this.frozen);
    return holding&&this.closesAt>0&&this.now()>=this.closesAt;
  }
  holdState(){return {open:this.open,frozen:this.frozen,sealed:this.sealed};}
  /** The draft's clock: null means it cannot promise any time, so a game could start at any moment. */
  setTimeLeft(left){
    if(this.phase!=='ChampSelect'||!this.guard||this.held)return;
    const pace=left===null||left<=FAST_WITHIN?'fast':'slow';
    if(pace===this.pace)return;
    this.pace=pace;
    this.guard.send(pace);
    this.log(`guard looks every ${pace==='fast'?10:100} ms`);
  }
  choicesOpen(){
    if(this.reconnectWindow)return true;
    // League's client says the draft is over a moment after the game exists. The freeze is the
    // truth: from then on only the settle is left, whatever the client still says.
    if(this.frozenOnce)return this.now()<this.closesAt;
    if(this.phase==='ChampSelect'||this.swiftplaySearching)return true;
    return this.open&&this.closesAt>0&&this.now()<this.closesAt;
  }
  /**
   * What this PC tells the party, which is also the stage its lobby shows. Outside a draft there
   * is nothing for anyone to wait for. 'armed' is ready while choices are still open: friends
   * keep waiting, as this player may still change their mind. Only 'prepared' and later release them.
   */
  partyState(){
    // Friends are already playing: nobody waits for a player coming back.
    if(this.fromReconnect)return this.released?'active':'prepared';
    if(this.phase!=='ChampSelect'&&(!this.open||this.gaveUp))return MATCH.has(this.phase)?'active':'prepared';
    if(!this.ready())return this.busy()||!this.engine.settled?'preparing':'syncing';
    if(this.engine.status==='failed')return 'error';
    if(this.choicesOpen())return this.engine.status==='ready'?'armed':'selected';
    return this.party.missing?.length?'partial':'prepared';
  }
  ready(){return !this.busy()&&this.engine.settled&&!this.party.settling;}
  /**
   * On League's Reconnect screen: whether pressing Reconnect now gets what is chosen, as LTK has
   * finished patching it and its scan is running. Null anywhere else. Pressing too early is not
   * lost (the guard holds the game, and may restart it once), but it is slower, so the panel says so.
   */
  reconnectSafe(){return this.reconnectWindow?this.ready():null;}
  setNote(note){if(note!==this.note){this.note=note;this.onChange();}}
  observe(phase,{gameGone=false,draftId,swiftplaySearching=false}={}){
    if(this.disposed)return;
    const previous=this.phase,wasSwiftplay=this.swiftplaySearching;
    this.phase=phase;this.swiftplaySearching=!!swiftplaySearching;
    if(phase==='ChampSelect'){
      if(previous!=='ChampSelect'||draftId!==undefined&&draftId!==this.draftId)this.arm();
      this.draftId=draftId;
    }else if(swiftplaySearching){
      // Swiftplay skips ChampSelect and jumps straight from ReadyCheck -> GameStart:
      // arm the launch guard as soon as matchmaking starts.
      if(!this.guard&&!this.held)this.arm();
      if(phase==='ReadyCheck')this.guard?.send('fast');
    }else if(MATCH.has(phase)){
      if((previous==='ChampSelect'||wasSwiftplay)&&this.guard){
        // The settle already runs from the freeze when that came first: this sighting is late by
        // however long League's client took to say so, and must not start it again.
        if(!this.frozenOnce)this.closesAt=this.now()+GRACE;
        this.guard.send('fast');
        this.log(wasSwiftplay?'swiftplay launch detected':'champion select ended');
        this.schedule(0);
      }
      const back=!(phase==='Reconnect'&&gameGone);
      if(this.reconnectWindow&&back)this.leaveReconnect();
      else if(!this.reconnectWindow&&!back&&!this.restarting&&!this.held)this.enterReconnect();
    }else this.disarm();
    this.sync();
  }
  /**
   * The game ended under a match still on. The same guard is ready for when it comes back, so
   * pressing Reconnect too early only makes League wait for the skin instead of missing it.
   */
  enterReconnect(){
    this.arm();
    this.reconnectWindow=true;this.fromReconnect=true;this.closesAt=1;
    // The game comes back the moment the player presses Reconnect.
    this.pace='fast';this.guard?.send('fast');
    this.log('the game ended and League offers Reconnect: skins may change');
    this.engine.repatch();
    this.setNote(RECONNECT_NOTE);
  }
  leaveReconnect(){
    this.reconnectWindow=false;this.closesAt=this.now();this.note='';
    this.guard?.send('fast');
    this.log('the game is coming back');
    this.schedule(0);this.onChange();
  }
  arm(){
    this.guard?.close();this.reset();
    // An old guard's last words must not be taken for this one's.
    const run=++this.guardRun;this.pace='slow';
    try{this.guard=this.start({onEvent:event=>{if(run===this.guardRun)this.receive(event);}});this.log('guard started');}
    catch(error){this.guard=null;this.log(`guard could not start: ${error.message}`);this.finished('Friloverse could not start its game guard. Skins may not load for this match.');this.onChange();}
  }
  reset(){
    this.closesAt=0;this.frozenOnce=false;this.released=false;this.held=null;this.restarts=0;this.restarting=false;this.gaveUp=false;this.note='';this.reconnectWindow=false;this.fromReconnect=false;
    clearTimeout(this.timer);this.timer=null;
  }
  disarm(){
    const guard=this.guard;this.guard=null;
    guard?.close();
    if(guard||this.released||this.note||this.reconnectWindow){this.reset();this.onChange();}
  }
  dispose(){this.disposed=true;this.disarm();this.engine.setHold({open:false,frozen:false,sealed:false});}
  sync(){
    this.engine.setHold(this.holdState());
    this.party.report(this.partyState());
  }
  schedule(delay=this.tick){
    if(this.disposed||this.timer)return;
    this.timer=setTimeout(()=>{this.timer=null;void this.step();},delay);this.timer.unref?.();
  }
  receive({event,pid,created,message}){
    this.log(`guard: ${event}${pid?` ${pid}`:''}${created?` created ${created}`:''}${message?` ${message}`:''}`);
    if(event==='suspended'){
      // The process is back before the client's next poll. Close the catalogue and choices now.
      if(this.reconnectWindow)this.leaveReconnect();
      // A stalled friend's limit runs from the first freeze: a restart does not wait for them again.
      this.held={pid,created,since:this.frozenOnce?this.firstFreeze:this.now()};this.restarting=false;
      if(!this.frozenOnce)this.firstFreeze=this.now();
      // The settle counts from the first freeze: League's phase can change before the game appears,
      // or a moment after. Choices that were already final stay final, and a restart gets no second one.
      if(!this.fromReconnect&&!this.frozenOnce&&!this.sealed)this.closesAt=Math.max(this.closesAt,this.now()+GRACE);
      this.frozenOnce=true;
      this.guard?.send('fast');
      this.schedule(0);
    }else if(event==='killed'){
      this.held=null;this.restarting=true;this.restartSince=this.now();
      void this.bringBack();
    }else if(event==='gone'){
      this.held=null;
    }else if(event==='expired'){
      this.finished('League could not wait any longer, so it opened without waiting for everything.');
    }else if(event==='blocked'){
      if(this.reconnectWindow)this.leaveReconnect();
      // Vanguard refuses to freeze the game. It opens as usual; nothing else is wrong.
      this.log(`guard could not freeze the game${message?`: ${message}`:''}`);
      this.finished('League opened before Friloverse could hold it, so skins could not load for this match.');
    }else if(event==='failed'){
      this.finished(plainHoldError(message)||'League could not be held.');
    }else if(event==='released'){
      this.finished(this.note);
    }else if(event==='closed'){
      const unexpected=!this.released&&!!this.guard&&!this.disposed;
      this.guard=null;
      if(unexpected)this.finished('Friloverse lost its game guard. Skins may not load for this match.');
    }
    this.sync();this.onChange();
  }
  finished(note){this.held=null;this.restarting=false;this.released=true;this.note=note||'';}
  /** Ask League's client to start the game again, until a new one shows up. */
  async bringBack(){
    // Right after the kill the client always answers no, so a wait comes first.
    let delay=RECONNECT_ASK,refused=0;
    const MATCH_PHASES=new Set(['','ChampSelect','GameStart','InProgress','Reconnect']);
    while(this.restarting&&!this.disposed&&this.now()-this.restartSince<RECONNECT_WAIT){
      await this.pause(delay);
      if(!this.restarting||this.disposed)break;
      // Abort early if the match ended / remade / dodged while waiting for reconnect.
      if(this.phase&&!MATCH_PHASES.has(this.phase)){
        this.log(`reconnect stopped: match phase became ${this.phase}`);
        this.restarting=false;this.released=true;this.guard?.send('release');this.sync();this.onChange();
        return;
      }
      const asked=this.now()-this.restartSince;
      delay=await this.reconnect().then(()=>{
        this.log(`League's client took the reconnect ${asked} ms after the game was ended${refused?` (${refused} refused before)`:''}`);
        refused=0;return RECONNECT_SHOW;
      },error=>{
        // One line for a run of refusals: only the first says why.
        if(!refused++)this.log(`reconnect: ${error.message}`);
        return RECONNECT_ASK;
      });
    }
    if(this.restarting){
      this.log('League did not come back');
      this.restarting=false;this.released=true;this.gaveUp=true;
      this.note='League did not start again. Use its Reconnect button.';
      this.guard?.send('release');this.sync();this.onChange();
    }
  }
  /** Why the game cannot go yet, in the words the player sees. Empty when it can. */
  reason(){
    if(this.now()<this.closesAt)return 'League is waiting: getting skins ready…';
    if(this.phase==='ChampSelect'&&this.engine.overlayOn&&this.now()-this.held.since<FINAL_SELECTION_WAIT){
      return 'League is waiting: reading the final skin selection…';
    }
    // The engine hears the choices are final before anyone asks whether it is finished.
    this.engine.setHold(this.holdState());
    if(!this.ready()){
      const left=Math.ceil((this.held.since+HOLD_LIMIT-this.now())/1000);
      return `League is waiting: getting skins ready…${left>0?` (${left} s at most)`:''}`;
    }
    return '';
  }
  async step(){
    if(this.disposed||!this.guard||this.released)return;
    this.sync();
    if(this.held&&!this.deciding){
      const reason=this.reason();
      this.setNote(reason);
      if(!reason){
        this.deciding=true;
        try{await this.decide();}
        catch(error){this.log(`could not decide: ${error.message}`);this.letGo();}
        finally{this.deciding=false;}
      }
    }else if(!this.held&&!this.restarting&&this.phase==='InProgress'&&this.closesAt&&this.now()-this.closesAt>NO_GAME_LIMIT){
      // League said the game is on, and no new game process ever appeared.
      this.log('no new game appeared');this.disarm();this.sync();return;
    }
    if(this.guard&&!this.released)this.schedule();
  }
  /**
   * Every party skin is in on this PC. Checked once per patch: the overlay holds them, and the
   * game was created under LTK's scan, or it is started again at once (not after any wait).
   * Then only a friend still choosing holds it, briefly, and a last look at the patcher.
   */
  async decide(){
    const held=this.held;
    if(held.checkedFor!==this.engine.patchedAt){
      // A patcher that died means a match with no skins, and a skin missing from LTK's overlay
      // would be the same. Either starts it again.
      if(await this.engine.checkPatcher({now:true}))return;
      this.setNote('League is waiting: checking your skin…');
      if(!await this.engine.confirmApplied())return;
      if(await this.restartNeeded(held)){
        if(this.held!==held||!this.ready())return;
        if(this.restarts>=MAX_RESTARTS){
          this.log('restart limit reached; the game was created before the skin scan');
          this.letGo('League opened after two restart attempts, but skins could not load for this match.');
          return;
        }
        this.restarts++;
        this.log(`starting the game again (${this.restarts})`);
        this.setNote('Starting League again so your skins load…');
        this.guard.send('kill');
        return;
      }
      held.checkedFor=this.engine.patchedAt;
    }
    const names=this.fromReconnect?[]:this.party.choosing();
    if(names.length&&this.now()-held.since<CHOICE_LIMIT){
      if(!held.choosingLogged){held.choosingLogged=true;this.log(`skins are in; waiting for ${names.length} friend(s) still choosing`);}
      this.setNote(`League is waiting for ${names.join(', ')} to finish choosing…`);
      return;
    }
    if(await this.engine.checkPatcher({now:true}))return;
    if(this.held===held&&this.ready()){
      if(names.length)this.log(`${names.length} friend(s) still choosing after ${CHOICE_LIMIT/1000} s; going`);
      this.letGo();
    }
  }
  /** A game created before LTK's scan began cannot get the overlay. */
  async restartNeeded(held){
    if(!this.engine.overlayOn)return false;
    const from=this.engine.patchAt;
    let scan=0;
    for(const giveUp=this.now()+SCAN_LOG_WAIT;;){
      scan=await this.scanStart().catch(()=>0)||0;
      if(scan>=from||this.now()>=giveUp)break;
      await this.pause(100);
    }
    // No line in LTK's log yet: the moment the patcher was seen running is close, and later.
    if(scan<from)scan=this.engine.patchedAt;
    this.log(`game created ${held.created}, scan began ${scan}`);
    return scan>=held.created;
  }
  letGo(note=''){
    this.log('releasing the game');
    this.held=null;this.released=true;this.note=note;
    this.guard?.send('release');
    this.sync();this.onChange();
  }
}
