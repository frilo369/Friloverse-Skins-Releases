import {mkdir,readFile,rename,rm,statfs,unlink,writeFile} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import path from 'node:path';
import {noGameProcess} from './lcu-safety.mjs';
import {buildSlotMod} from './skin-slots.mjs';
import {shownName} from './skin-names.mjs';

// During a draft skins are queued: LTK Manager installs and checks each one as it is picked,
// which says at once whether it can load. Its patcher starts once, when the choices are final
// (`hold.sealed`), or earlier: as soon as what is queued has stood unchanged for ARM_QUIET, still
// in the draft, so LTK's scan is running before League creates the game and the game need not be
// started again (owner's request, 2026-11-11). A later change takes the patcher down and queues again.
const STAGE=new Set(['ChampSelect','GameStart']);
const HOLD=new Set(['InProgress','Reconnect']);
// A failed draft is retried fast: the game is coming, or held waiting. Undoing is not urgent.
const SETTLE=100,RETRY=10000,STAGE_RETRY=1500,GAME_RETRY=1000,MAX_TRIES=3;
const STOP_TIMEOUT=120000,LOW_DISK_BYTES=1024**3;
// How often the patcher is looked at during a draft, and how many times it is brought back.
const PATCHER_CHECK=2000,MAX_REVIVES=2;
// A pick that has stood this long in the draft gets its patcher. Shorter, and somebody clicking
// through skins would start and stop LTK Manager for each one.
export const ARM_QUIET=3000;
// Each time a change takes a started patcher down in the same draft, the next one waits twice as
// long, up to this: a party of five swapping champions and skins must not have LTK Manager
// starting and stopping on every PC for the whole draft. A calm draft never notices.
export const ARM_QUIET_MAX=12000;
// LTK's own answers about a skin stand. Anything else may be gone in a moment.
const FILE_BUSY=new Set(['EPERM','EBUSY','EACCES']);
const temporary=error=>error?.retry===true||!error?.plain&&(!error?.code||FILE_BUSY.has(error.code));
const wait=ms=>new Promise(done=>setTimeout(done,ms));

const PLAIN={
  LEAGUE_ELEVATED:'League is running as administrator, so LTK Manager cannot reach it. Turn that off for League and try again.',
  MANAGER_ELEVATED:'LTK Manager is running as administrator, which it refuses. Close it from its tray icon and try again.',
  DLL_UNAVAILABLE:'LTK Manager could not get its game helper. Check your connection and try again.',
  UNSUPPORTED_PLATFORM:'LTK Manager does not support this version of Windows.',
  BUSY:'LTK Manager is busy right now. Try again in a moment.',
  LOW_DISK_SPACE:'Not enough free disk space for LTK Manager to install this skin. Free up at least 1 GB and try again.',
};
export function plainLtkError(error){
  return PLAIN[error?.code]||(error?.plain?error.message:`LTK Manager: ${error?.message||'unknown error'}`);
}

async function lowDiskSpace(folder){
  try{
    const info=await statfs(folder);
    const free=Number(info.bavail)*Number(info.bsize);
    return Number.isFinite(free)&&free>=0&&free<LOW_DISK_BYTES;
  }catch{return false;}
}

/**
 * What LTK Manager should load, kept here and not in its library: skins are added
 * for one match and taken away again, and every champion select starts with none.
 * The player's own LTK mods are switched off meanwhile. A journal written before
 * each change lets a crash or a power cut be undone at the next start.
 */
export class SkinEngine{
  constructor({bridge,dataDir,noGame=noGameProcess,onChange=()=>{},settle=SETTLE,arm=ARM_QUIET,pause=wait,now=Date.now,buildSlot=buildSlotMod,buildNames=null,onSlotFailed=()=>{},prepareFile=async file=>file,keepPrepared=async()=>{},onRetry=()=>{},onArmed=()=>{}}){
    Object.assign(this,{bridge,noGame,onChange,settle,arm,pause,now,buildSlot,buildNames,onSlotFailed,prepareFile,keepPrepared,onRetry,onArmed});
    this.slotDir=path.join(dataDir,'skin-slots');this.slots=new Map();
    this.journalPath=path.join(dataDir,'engine-journal.json');this.dataDir=dataDir;
    this.journal={staged:[],userEnabled:null};
    this.personal=null;this.personalList=[];this.party=[];this.mods=[];this.phase='';this.swiftplayStaging=false;
    this.applied='';this.tries=0;this.triedFor='';this.retryAt=0;this.timer=null;
    this.busy=false;this.again=false;this.closed=false;this.failures=new Map();this.refused=new Map();this.error='';this.status='idle';
    this.hold={open:false,frozen:false,sealed:false};this.prepared='';this.waiting=false;this.patchAt=0;this.patchedAt=0;
    // What has stood queued long enough for its patcher to start during the draft.
    this.armFor='';this.armTimer=null;this.takenDown=0;this.draftLeft=Infinity;
    this.patcherCheckAt=0;this.patcherMissed=0;this.checkingPatcher=false;this.revives=0;this.revivedFor='';
  }
  async load(){
    try{
      const saved=JSON.parse(await readFile(this.journalPath,'utf8'));
      const valid=Array.isArray(saved?.staged)&&saved.staged.every(row=>typeof row?.key==='string'&&typeof row.modId==='string'&&typeof row.ours==='boolean')&&(saved.userEnabled===null||Array.isArray(saved.userEnabled))&&(saved.installing===undefined||Array.isArray(saved.installing));
      if(valid)this.journal=saved;
    }catch{/* Nothing to undo. */}
    if(this.pendingRestore||typeof this.journal.alwaysStart==='boolean')this.schedule(0);
  }
  get pendingRestore(){return this.journal.staged.length>0||this.journal.userEnabled!==null||this.journal.patching===true;}
  /** Nothing is loaded and LTK Manager is not needed, so an app update may restart. */
  get idle(){return !this.busy&&!this.pendingRestore&&!this.bridge.connected;}
  wanted(){
    const seen=new Set(),files=[];
    const own=this.personalList.length?this.personalList:this.personal?[this.personal]:[];
    for(const file of [...own,...this.party,...this.mods]){
      if(!file||seen.has(file.key))continue;
      seen.add(file.key);files.push(file);
      // League loads the skin selected in its client: the same skin again at that number.
      const slot=this.slots.get(String(file.alias||'').toLowerCase());
      if(slot)files.push({key:`${file.key}@${slot}`,slotOf:file,slot,label:file.label,trusted:file.trusted,repair:file.repair});
    }
    // The loading screen names what is selected in League's client; the player's own pick(s) replace that name.
    for(const pick of own){
      const name=this.buildNames&&pick?.alias?shownName(pick.label):'';
      if(name){
        const alias=String(pick.alias).toLowerCase(),slot=this.slots.get(alias)||0;
        files.push({key:`name:${alias}:${slot}:${name}`,slotOf:pick,names:{alias,slot,name},label:`The name of ${name}`});
      }
    }
    return files;
  }
  signature(files=this.wanted()){return files.map(file=>file.key).sort().join(',');}
  /** Whether this skin made it into LTK Manager, once the current plan has run. */
  failureFor(key){return this.failures.get(key)||'';}
  slotFailed(file,detail){
    if(file.names)return;
    const pick=file.slotOf;
    this.failures.set(pick.key,`${pick.label||'This skin'} could not be applied over the skin selected in League.`);
    this.onSlotFailed(pick.alias,detail);
  }
  setPersonal(file){
    const next=Array.isArray(file)?file.filter(Boolean):file?[file]:[];
    const prev=this.personalList.length?this.personalList:this.personal?[this.personal]:[];
    if(this.signature(next)===this.signature(prev))return;
    this.personalList=next;
    this.personal=next[0]||null;
    this.changed();
  }
  setSwiftplay(active){
    const next=!!active;
    if(next===this.swiftplayStaging)return;
    this.swiftplayStaging=next;
    this.schedule(0);
  }
  setParty(files){const next=[...files];if(this.signature(next)!==this.signature(this.party)){this.party=next;this.changed();}}
  /** The skin each champion on the team has selected in the client, by internal name. */
  setSlots(slots){
    const next=new Map([...slots].filter(([,slot])=>slot>0));
    if(JSON.stringify([...next].sort())===JSON.stringify([...this.slots].sort()))return;
    const before=this.signature();
    this.slots=next;
    if(this.signature()!==before)this.changed();
  }
  setMods(files){const next=[...files];if(this.signature(next)!==this.signature(this.mods)){this.mods=next;this.changed();}}
  /** Skins may still change: during the draft, Swiftplay lobby/queue, or while League's game is being held back. */
  get staging(){return STAGE.has(this.phase)||this.swiftplayStaging||this.hold.open;}
  /** Nothing left to do for what is wanted now. A failure counts once no retry is left: it has been told to the player. */
  get settled(){return !this.busy&&!this.waiting&&!this.retryAt&&(this.applied===this.signature()||this.queueing&&this.prepared===this.signature()||this.status==='failed');}
  /** Choices are still open, so what is wanted waits in LTK Manager's library. */
  get queueing(){return !this.hold.sealed&&(this.phase==='ChampSelect'||this.swiftplayStaging||this.hold.open);}
  /** LTK Manager has an overlay to give this match. */
  get overlayOn(){return this.journal.patching===true;}
  setHold(hold){
    const was=this.hold;this.hold=hold;
    if(was.open!==hold.open||was.frozen!==hold.frozen||!was.sealed!==!hold.sealed)this.schedule(0);
  }
  changed(){if(this.staging)this.schedule();}
  /** The game is gone and so may be what patched it: the next game gets a scan of its own. */
  repatch(){if(this.journal.patching){this.applied='repatch';this.schedule(0);}}
  observe(phase){
    const previous=this.phase;this.phase=phase;
    if(phase!==previous)this.schedule(STAGE.has(phase)&&STAGE.has(previous)?this.settle:0);
    else if(this.retryAt&&this.now()>=this.retryAt){this.retryAt=0;this.schedule(0);}
    else void this.checkPatcher();
  }
  /**
   * LTK Manager can die, or be closed from its tray, after the patcher started. Nothing says
   * so, and the match would just have no skins. Two looks apart, as it restarts itself once.
   * Returns whether a new start is on its way.
   */
  async checkPatcher({now=false}={}){
    const quiet=()=>this.staging&&this.overlayOn&&!this.busy&&!this.waiting&&this.applied===this.signature();
    if(!quiet()||this.checkingPatcher||!now&&this.now()<this.patcherCheckAt)return false;
    this.checkingPatcher=true;
    try{
      this.patcherCheckAt=this.now()+PATCHER_CHECK;
      if(await this.bridge.patcherAlive()){this.patcherMissed=0;return false;}
      if(now){await this.pause(200);if(await this.bridge.patcherAlive())return false;}
      else if(++this.patcherMissed<2)return false;
      this.patcherMissed=0;
      if(!quiet()||!this.hold.frozen&&!await this.noGame())return false;
      const target=this.signature();
      if(this.revivedFor!==target){this.revivedFor=target;this.revives=0;}
      if(++this.revives>MAX_REVIVES)return false;
      this.onRetry('LTK Manager\'s patcher stopped by itself; starting it again');
      this.applied='repatch';this.schedule(0);
      return true;
    }catch{return false;}
    finally{this.checkingPatcher=false;}
  }
  /**
   * Before a held game goes: every skin that should be loaded must really be in the overlay LTK
   * built. True when League may go. False starts the patcher again, once per set of skins, as a
   * skin LTK left out would otherwise only be found out in the game.
   */
  async confirmApplied(){
    if(!this.overlayOn)return true;
    const files=this.wanted().filter(file=>!file.slotOf&&file.alias&&!this.failures.has(file.key));
    const champions=[...new Set(files.map(file=>file.alias))];
    if(!champions.length)return true;
    const slots=new Map(champions.map(alias=>[alias,this.slots.get(alias.toLowerCase())]).filter(([,slot])=>slot));
    const target=this.signature();
    const missing=await this.bridge.overlayMissing(champions,slots).catch(()=>[]);
    if(this.signature()!==target)return false;
    if(!missing.length)return true;
    if(this.confirmedFor===target){
      this.onRetry(`${missing.join(', ')} still not in LTK Manager's overlay; League goes on without waiting longer`);
      for(const file of files)if(missing.includes(file.alias)){
        this.failures.set(file.key,`${file.label||'This skin'} is missing from LTK Manager’s game overlay.`);
      }
      this.error=[...this.failures.values()][0];
      this.setStatus('failed');
      return true;
    }
    this.confirmedFor=target;
    this.onRetry(`${missing.join(', ')} not in LTK Manager's overlay; patching again`);
    this.applied='repatch';this.schedule(0);
    return false;
  }
  schedule(delay=this.settle){
    if(this.closed)return;
    clearTimeout(this.timer);this.waiting=true;
    this.timer=setTimeout(()=>{void this.pump();},delay);this.timer.unref?.();
  }
  setDraftTimeLeft(ms){
    this.draftLeft=Number.isFinite(ms)&&ms>=0?ms:Infinity;
  }
  /**
   * Start the patcher for what is queued once it has stood unchanged for `arm`. Its own timer,
   * as nothing is pending meanwhile: the pick is in and accepted, and `settled` must say so.
   */
  armLater(target){
    clearTimeout(this.armTimer);this.armTimer=null;this.armFor='';
    if(this.closed||!Number.isFinite(this.arm)||this.arm<0)return;
    let quiet=Math.min(this.arm*2**this.takenDown,Math.max(this.arm,ARM_QUIET_MAX));
    // Cap against remaining finalization clock so a late pick arms before League spawns.
    if(Number.isFinite(this.draftLeft))quiet=Math.min(quiet,Math.max(0,this.draftLeft-4000));
    this.armTimer=setTimeout(()=>{
      this.armTimer=null;
      if(this.closed||!this.queueing||this.prepared!==target||this.signature()!==target)return;
      this.armFor=target;
      // A run already on its way sees this too.
      if(!this.waiting)void this.pump();
    },quiet);this.armTimer.unref?.();this.armWait=quiet;
  }
  async pump(){
    this.waiting=false;
    if(this.closed)return;
    if(this.busy){this.again=true;return;}
    this.busy=true;
    try{
      do{
        this.again=false;
        try{
          if(this.staging)await this.stage();
          else if(!HOLD.has(this.phase))await this.cleanup();
          else{
            // The game is on: an LTK that was only waiting for a pick has no more to do.
            // One whose patcher is running must stay: with the bundled LTF bridge the
            // manager that patches is the same connected one, and closing it here would
            // kill the patcher host before it finds the game.
            if(this.bridge.connected&&!this.journal.patching)await this.bridge.quit();
            // Reached only if the game could not wait: what did not get in is said.
            const missed=this.applied!==this.signature();
            if(this.status==='applying'||missed&&this.status==='ready'){
              this.retryAt=0;
              if(!missed)this.setStatus('ready');
              else{this.error='A skin did not make it in time for this match.';this.setStatus('failed');}
            }
          }
        }catch(error){
          this.scheduleRetry();
          this.onRetry(`${plainLtkError(error)}${this.retryAt?' (trying again)':''}`);
          // A hiccup with another try coming is nobody's business. What needs the player, or was the last try, is told.
          if(this.retryAt&&this.staging&&temporary(error))this.setStatus('applying');
          else{this.error=plainLtkError(error);this.setStatus('failed');}
        }
      }while(this.again&&!this.closed);
    }finally{this.busy=false;this.onChange();}
  }
  scheduleRetry(){
    const target=this.signature();
    if(this.triedFor!==target){this.triedFor=target;this.tries=0;}
    // Staging is only retried a few times; undoing it is retried until it works.
    if(!this.staging)this.retryAt=this.now()+RETRY;
    else this.retryAt=++this.tries<MAX_TRIES?this.now()+STAGE_RETRY:0;
  }
  setStatus(status){if(status!==this.status){this.status=status;this.onChange();}}
  async saveJournal(){
    await mkdir(this.dataDir,{recursive:true});
    const temp=`${this.journalPath}.${randomBytes(8).toString('hex')}.tmp`;
    try{await writeFile(temp,JSON.stringify(this.journal),{encoding:'utf8',flag:'wx'});await rename(temp,this.journalPath);}
    finally{await unlink(temp).catch(()=>{});}
  }
  /**
   * A crash after LTK Manager installed a skin and before the journal said so leaves one mod that
   * nothing would ever remove. `installing` is the library just before that install, so the stray
   * is whatever has appeared since. Only one install runs at a time: more than one newcomer means
   * the player added something, and a mod that may be theirs stays.
   */
  async removeStray(){
    if(!this.journal.installing)return;
    const known=new Set([...this.journal.installing,...this.journal.staged.map(row=>row.modId)]);
    const strays=(await this.bridge.mods()).filter(mod=>!known.has(mod.id));
    if(strays.length===1)await this.removeMod(strays[0].id);
    delete this.journal.installing;await this.saveJournal();
  }
  /** A mod already gone from LTK Manager's library needs no removing, and that must not cost the match. */
  async removeMod(modId){await this.bridge.uninstall(modId).catch(error=>{if(error?.code!=='MOD_NOT_FOUND')throw error;});}
  /** The player or LTK Manager can take a staged mod out at any time. Whatever is still wanted goes in again below. */
  async forgetRemoved(library){
    const present=new Set(library.map(mod=>mod.id)),kept=this.journal.staged.filter(row=>present.has(row.modId));
    if(kept.length!==this.journal.staged.length){this.journal.staged=kept;await this.saveJournal();}
  }
  async stopPatcher(){
    const status=await this.bridge.status();
    if(!status?.running&&(!status?.phase||status.phase==='idle'))return;
    await this.bridge.stop().catch(error=>{if(error?.code!=='NOT_RUNNING')throw error;});
    const deadline=this.now()+STOP_TIMEOUT;
    for(let i=0;i<600;i++){
      const current=await this.bridge.status();
      if(!current?.running&&(!current?.phase||current.phase==='idle'))return;
      if(this.now()>=deadline)break;
      await this.pause(200);
    }
    throw new Error('its patcher did not stop.');
  }
  /** The LTK Manager patching this match has no debug port, so it is closed first. */
  async endPatching(){
    if(!this.journal.patching)return;
    await this.bridge.endPatching();
    this.journal.patching=false;await this.saveJournal();
  }
  async rememberPatcherChoice(){
    if(typeof this.journal.alwaysStart==='boolean')return;
    this.journal.alwaysStart=await this.bridge.patcherAtStart();await this.saveJournal();
  }
  /**
   * LTK Manager takes about two seconds to start and check its first skin, so during a
   * draft it is opened before any pick, hidden, and closed if the game starts without one.
   */
  async warm(){
    if(this.phase!=='ChampSelect'&&!this.hold.open){
      if(this.bridge.connected&&!this.journal.staged.length&&!this.journal.patching)await this.bridge.quit();
      return;
    }
    if(this.bridge.connected||!await this.noGame())return;
    try{await this.rememberPatcherChoice();await this.bridge.ensure();}
    catch{/* Only a pick needs it; that will say what is wrong. */}
  }
  /** Prepared copies were already checked for this League; other files still need preflight. */
  async problemWith(file,row){
    // A handcrafted form (Viego's swords) is old data beside current League files, so
    // LTK's Repair fixes its property types the same way it does a custom skin's.
    if((file.trusted&&!file.repair)||file.prepared)return '';
    const problem=await this.bridge.readyMod(row.modId,{repair:row.ours});
    if(problem==='skinhack')return `LTK Manager treats ${file.label||'this skin'} as a skin hack and will not load it. Choose another skin.`;
    return problem?`LTK Manager could not repair ${file.label||'this skin'} for this version of League. Choose another skin.`:'';
  }
  async stage(){
    const files=this.wanted(),target=this.signature(files);
    if(target===this.applied){if(!target)await this.warm();return;}
    // Queued and accepted. Its patcher starts when it has stood for a moment, or when choices close.
    const arming=this.queueing&&target===this.prepared;
    if(arming&&this.armFor!==target)return;
    if(!this.hold.frozen&&!await this.noGame()){
      // The game may be a moment from being frozen: the guard looks far more often than this.
      if(this.hold.open)await this.pause(150);
      if(!this.hold.frozen){
        // Still queued and accepted: only its early patcher waits, for the last game to close.
        if(arming){this.retryAt=this.now()+GAME_RETRY;return;}
        // Changing the overlay under a running game is never safe.
        if(files.length)this.error='League had already opened, so this applies from the next match.';
        // During a draft this can be the last game still closing. Once this game starts,
        // settle the missed pick; a later guard freeze/reconnect explicitly schedules again.
        this.retryAt=this.phase==='ChampSelect'?this.now()+GAME_RETRY:0;
        this.setStatus(files.length?'failed':'idle');
        this.onChange();return;
      }
    }
    if(!files.length&&!this.journal.staged.length&&!this.journal.patching){
      this.applied=target;this.failures=new Map();this.error='';this.retryAt=0;
      await this.warm();
      this.setStatus('idle');return;
    }
    // Arming changes nothing the player chose: what is queued stays 'ready' while its patcher starts.
    if(!arming){this.setStatus('applying');this.prepared='';}
    this.error='';
    // What was patched is taken apart here, so it only counts as applied once patched again.
    if(this.journal.patching){
      this.applied='repatch';
      // A change of mind, not a patcher that died and is only started again.
      if(this.queueing&&!arming)this.takenDown++;
    }
    await this.endPatching();
    await this.rememberPatcherChoice();
    // A skin was asked for, so an LTK Manager left open must not stand in the way.
    await this.bridge.ensure({takeOver:true});
    await this.stopPatcher();
    const moved=()=>{if(this.signature()===target)return false;this.again=true;return true;};
    if(moved())return;
    await this.removeStray();
    let library=await this.bridge.mods();
    await this.forgetRemoved(library);
    if(this.bridge.canToggle!==false&&this.journal.userEnabled===null){
      const staged=new Set(this.journal.staged.map(row=>row.modId));
      this.journal.userEnabled=library.filter(mod=>mod.enabled&&!staged.has(mod.id)).map(mod=>mod.id);
      await this.saveJournal();
    }
    const keys=new Set(files.map(file=>file.key));
    for(const row of [...this.journal.staged]){
      if(keys.has(row.key))continue;
      if(row.ours){
        try{await this.removeMod(row.modId);}
        catch(error){
          // A transient Windows file lock during removal must not abort the match: turn the mod off
          // and keep it journaled so the next cleanup removes it. Other LTK errors still fail.
          if(FILE_BUSY.has(error?.code)&&this.bridge.canToggle!==false){
            await this.bridge.toggle(row.modId,false).catch(()=>{});
            this.onRetry(`Could not remove an earlier skin (${plainLtkError(error)}); turned it off instead`);
            continue;
          }
          throw error;
        }
      }
      this.journal.staged=this.journal.staged.filter(item=>item!==row);
      await this.saveJournal();
    }
    this.failures=new Map();
    let hiccup=false;
    for(const file of files){
      if(file.names&&this.failures.has(file.slotOf.key))continue;
      // LTK's content verdict survives party/slot changes and repatching this match.
      // Temporary install/connection errors still take the normal retry path.
      const refusal=this.refused.get(file.key);
      if(refusal){
        if(file.slotOf)this.slotFailed(file,refusal);else this.failures.set(file.key,refusal);
        continue;
      }
      if(this.journal.staged.some(row=>row.key===file.key))continue;
      // Only ever beside its original, which LTK Manager has just accepted.
      if(file.slotOf&&!this.journal.staged.some(row=>row.key===file.slotOf.key))continue;
      let working;
      try{
        const original=file.slotOf||file;
        const prepared=file.names||original.trusted?original:await this.prepareFile(original);
        if(prepared?.key!==original.key||typeof prepared.file!=='string')throw new Error('The prepared skin did not match the requested skin.');
        if(prepared.working)working=prepared.file;
        let source=prepared.file;
        if(file.slotOf){
          source=await (file.names?this.buildNames({...file.names,dir:this.slotDir}):this.buildSlot({file:prepared.file,champion:original.alias,slot:file.slot,dir:this.slotDir}));
          if(!source){this.slotFailed(file,'The selected slot copy could not be built.');continue;}
        }
        // Written down first: see removeStray.
        this.journal.installing=[...new Set([...library.map(mod=>mod.id),...this.journal.staged.map(row=>row.modId)])];
        await this.saveJournal();
        // LTK Manager keeps its own copy of what it installs.
        const outcome=await this.bridge.install(source);
        const modId=outcome?.mod?.id;
        if(typeof modId!=='string')throw new Error('it did not report the installed skin.');
        if(this.journal.staged.some(row=>row.modId===modId))throw new Error('it treated this skin as a newer version of another one.');
        // A mod the player already had stays theirs when this match ends.
        const row={key:file.key,modId,ours:outcome.kind==='installed'};
        this.journal.staged.push(row);
        delete this.journal.installing;
        await this.saveJournal();
        // A name is never covered by its skin's checks: LTK looks at it as what it is.
        const problem=await this.problemWith({...file,prepared:file.names?false:prepared.prepared},row);
        if(problem){
          if(row.ours)await this.removeMod(modId);
          this.journal.staged=this.journal.staged.filter(item=>item!==row);
          await this.saveJournal();
          this.refused.set(file.key,problem);
          if(file.slotOf){this.slotFailed(file,problem);continue;}
          throw Object.assign(new Error(problem),{plain:true});
        }
        // Checked and repaired just now: the next pick, and a slot copy below, start from this.
        if(!file.slotOf&&!original.trusted&&prepared.prepared===false)await this.keepPrepared(original,modId).catch(error=>this.onRetry(`${original.label||'A custom skin'} was not kept: ${error.message}`));
      }catch(error){
        // LTK Manager may have installed it and only its reply was lost: the newcomer goes now,
        // before anything forgets it. Unable to look, `installing` stays for the next look (10.5).
        if(this.journal.installing)await this.removeStray().catch(()=>{});
        if(!error?.code&&await lowDiskSpace(this.dataDir))error=Object.assign(new Error(PLAIN.LOW_DISK_SPACE),{code:'LOW_DISK_SPACE',plain:true});
        if(file.slotOf){
          this.slotFailed(file,plainLtkError(error));
          if(!file.names)hiccup||=temporary(error);
        }
        else{this.failures.set(file.key,plainLtkError(error));hiccup||=temporary(error);}
      }finally{if(working)await unlink(working).catch(()=>{});}
      if(moved())return;
    }
    library=await this.bridge.mods();
    const skippedNames=new Set(files.filter(file=>file.names&&this.failures.has(file.slotOf.key)).map(file=>file.key));
    const active=new Set(this.journal.staged.filter(row=>!skippedNames.has(row.key)).map(row=>row.modId));
    if(this.bridge.canToggle!==false)for(const mod of library){
      if(Boolean(mod.enabled)!==active.has(mod.id))await this.bridge.toggle(mod.id,active.has(mod.id));
    }
    if(moved())return;
    if(active.size&&this.queueing&&!arming){this.prepared=target;this.armLater(target);}
    else{
      // `armFor` stays: a patcher that dies in the draft is started again for the same skins.
      clearTimeout(this.armTimer);this.armTimer=null;
      if(active.size){
        this.journal.patching=true;await this.saveJournal();
        this.patchAt=this.now();
        // A change meanwhile makes this start worthless: it is given up at once, and what is
        // wanted now is worked through from the top.
        if(await this.bridge.patch({stale:()=>this.closed||this.signature()!==target})===false){this.again=true;return;}
        this.patchedAt=this.now();
        // For the log: a match whose game needed no restart can be told from one that did.
        if(arming)this.onArmed(this.patchedAt-this.patchAt);
      }else await this.warm();
      this.applied=target;
    }
    this.retryAt=0;
    // The rest of the match is loaded. A skin that only hit a hiccup gets another go.
    if(hiccup&&this.staging){
      this.scheduleRetry();
      if(this.retryAt){
        this.onRetry(`${[...this.failures.values()][0]} (trying again)`);
        this.applied='retry';this.prepared='';this.setStatus('applying');return;
      }
    }else this.tries=0;
    if(this.failures.size)this.error=[...this.failures.values()][0];
    this.setStatus(this.failures.size?'failed':active.size?'ready':'idle');
  }
  /** Undo everything for this match, unless the game is still running. */
  async cleanup(){
    if(!this.pendingRestore&&!this.bridge.connected&&!this.applied&&!this.bridge.child&&typeof this.journal.alwaysStart!=='boolean')return;
    if(!await this.noGame()){this.retryAt=this.now()+RETRY;return;}
    const atStart=this.journal.alwaysStart;
    if(this.pendingRestore){
      this.setStatus('applying');
      await this.endPatching();
      // The library still holds this match's skins and the player's own mods are off.
      await this.bridge.ensure({takeOver:true});
      await this.stopPatcher();
      await this.removeStray();
      for(const row of [...this.journal.staged]){
        if(row.ours)await this.removeMod(row.modId);
        this.journal.staged=this.journal.staged.filter(item=>item!==row);
        await this.saveJournal();
      }
      const before=new Set(this.journal.userEnabled||[]);
      if(this.bridge.canToggle!==false)for(const mod of await this.bridge.mods()){
        if(Boolean(mod.enabled)!==before.has(mod.id))await this.bridge.toggle(mod.id,before.has(mod.id));
      }
      // The patcher setting stays written down until it has really been put back, below.
      this.journal={staged:[],userEnabled:null,...(typeof atStart==='boolean'?{alwaysStart:atStart}:{})};await this.saveJournal();
    }
    this.applied='';this.prepared='';this.failures=new Map();this.refused.clear();this.error='';this.tries=0;this.retryAt=0;this.confirmedFor='';
    clearTimeout(this.armTimer);this.armTimer=null;this.armFor='';this.takenDown=0;
    await rm(this.slotDir,{recursive:true,force:true}).catch(()=>{});
    await this.bridge.quit();
    // Back to the player's own choice, now that LTK Manager is closed.
    if(typeof atStart==='boolean'){
      await this.bridge.setPatcherAtStart(atStart).catch(()=>{});
      delete this.journal.alwaysStart;await this.saveJournal();
    }
    this.setStatus('idle');
  }
  /** Quitting: never disturb a running game. Its journal is undone at the next start. */
  async shutdown(){
    clearTimeout(this.timer);clearTimeout(this.armTimer);
    while(this.busy)await this.pause(50);
    this.closed=true;
    if(await this.noGame().catch(()=>false)){
      try{await this.cleanup();}catch{/* The journal stays for the next start. */}
    }else this.bridge.detach();
  }
}
