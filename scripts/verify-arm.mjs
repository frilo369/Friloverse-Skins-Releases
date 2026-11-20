// The draft as 9.2 runs it, with the real engine on the real LTK Manager and no League: a pick is
// queued, its patcher starts by itself once the pick has stood still (ARM_QUIET), and when the
// draft ends nothing is left to do, so the game that League creates then is already under LTK's
// scan and needs no restart. Also timed: changing the pick after the patcher started, and a
// change under a game that is already frozen (the one case that still restarts the game).
// The times that matter come from LTK's own log. Undoes everything; refuses during a draft or
// game, or if LTK is open.
import {mkdtemp,readFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {LtkBridge,ltkRunning} from '../src/ltk.mjs';
import {RiotCatalogue} from '../src/riot-skins-local.mjs';
import {ARM_QUIET,SkinEngine} from '../src/engine.mjs';
import {assertMachineIdle,ensureZstdRuntime} from './lib/runtime.mjs';

ensureZstdRuntime(import.meta.url);
await assertMachineIdle();

const pause=ms=>new Promise(done=>setTimeout(done,ms));
const fails=[];
const check=(ok,what)=>{console.log(`${ok?'ok  ':'FAIL'} ${what}`);if(!ok)fails.push(what);};
const logs=path.join(process.env.APPDATA,'dev.leaguetoolkit.manager','logs');
/** When LTK's patcher began scanning, by its own log, at or after this moment. */
async function scanStarted(after){
  const newest=(await readdir(logs)).filter(name=>name.endsWith('.log')).sort().at(-1);
  for(let i=0;i<40;i++){
    const text=await readFile(path.join(logs,newest),'utf8');
    for(const line of text.split('\n').reverse()){
      if(!line.includes('session started: scanning for game'))continue;
      const at=Date.parse(line.slice(0,27));
      if(at>=after)return at;
      break;
    }
    await pause(100);
  }
  return null;
}

const dataDir=await mkdtemp(path.join(tmpdir(),'friloverse-arm-'));
const catalogue=new RiotCatalogue();
await catalogue.check();
const [first,second,third]=(await catalogue.forChampion(11)).slice(0,3);
const files=[];
for(const skin of [first,second,third]){const built=await catalogue.ensure(11,skin.id);files.push({key:built.sha,file:built.file,label:`Skin ${skin.id}`,trusted:true});}

const bridge=new LtkBridge();
const statuses=[];
const engine=new SkinEngine({bridge,dataDir,onChange:()=>{if(statuses.at(-1)!==engine.status)statuses.push(engine.status);}});
const until=async(done,limit=60000)=>{for(const end=Date.now()+limit;Date.now()<end&&!done();)await pause(20);return done();};
const queued=()=>!engine.busy&&!engine.waiting&&engine.prepared===engine.signature();
const patched=()=>!engine.busy&&engine.applied===engine.signature()&&engine.overlayOn;
try{
  // The draft opens: no game, choices open.
  engine.setHold({open:false,frozen:false,sealed:false});engine.observe('ChampSelect');
  await pause(50);await until(()=>!engine.busy&&bridge.connected);
  await pause(3000);

  let mark=Date.now();statuses.length=0;
  engine.setPersonal(files[0]);
  await until(queued);
  console.log(`     pick -> accepted by LTK and shown ready: ${Date.now()-mark} ms`);
  check(engine.status==='ready'&&engine.settled&&!engine.overlayOn,'the pick is in, ready, and its patcher has not started yet');
  const queuedAt=Date.now();
  await until(patched);
  let scan=await scanStarted(mark);
  check(patched()&&await bridge.patcherAlive(),'the patcher started by itself, still in the draft');
  check(scan!==null,'LTK\'s own log shows its scan running');
  console.log(`     quiet time ${ARM_QUIET} ms; patcher up ${Date.now()-queuedAt} ms after the pick was in; LTK scanning ${scan?scan-mark:'?'} ms after the click`);
  check(statuses.every(status=>status==='applying'||status==='ready')&&statuses.at(-1)==='ready'&&statuses.indexOf('applying')<=0,`the panel never left ready once the pick was in (${statuses.join(' > ')})`);
  check(engine.settled,'and Friloverse is settled, so nothing would hold League');

  // The draft ends: League creates its game now, and the guard freezes it.
  await pause(1500);
  const created=Date.now();mark=Date.now();
  engine.observe('GameStart');engine.setHold({open:true,frozen:true,sealed:true});
  await pause(30);await until(()=>engine.settled);
  console.log(`     draft end -> everything in place: ${Date.now()-mark} ms`);
  check(engine.applied===engine.signature()&&await bridge.patcherAlive(),'nothing had to be done when the choices closed');
  check(scan!==null&&scan<created,`the game was created ${scan?created-scan:'?'} ms after LTK's scan began: no restart`);
  check(await engine.confirmApplied(),'the skin is in the overlay LTK built');

  // Back to a draft (as after a dodge and a new queue), to time a change of mind.
  engine.setHold({open:false,frozen:false,sealed:false});engine.observe('ChampSelect');
  await pause(200);await until(()=>!engine.busy);
  mark=Date.now();statuses.length=0;
  engine.setPersonal(files[1]);
  await until(()=>queued()&&engine.status==='ready');
  console.log(`     changing the pick after the patcher started -> new pick ready: ${Date.now()-mark} ms`);
  check(!engine.overlayOn&&!await bridge.patcherAlive(),'the old patcher was taken down for the change');
  await until(patched);
  scan=await scanStarted(mark);
  check(patched()&&scan!==null,'and the new pick got its own patcher');
  console.log(`     LTK scanning ${scan?scan-mark:'?'} ms after the change`);

  // A busy party: a friend's skin arrives while this PC's patcher is still starting.
  const startedBefore=engine.patchAt;
  engine.setPersonal(files[0]);
  // patchAt moves the moment the engine asks LTK to start patching.
  await until(()=>engine.busy&&engine.patchAt!==startedBefore);
  await pause(300);
  check(engine.busy,'the patcher is in the middle of starting');
  mark=Date.now();
  engine.setParty([files[2]]);
  await until(()=>queued()&&engine.status==='ready');
  console.log(`     a friend's skin arriving while the patcher was starting -> in and ready: ${Date.now()-mark} ms`);
  check(Date.now()-mark<4000&&!engine.overlayOn,'that start was given up at once, not waited for');
  console.log(`     quiet time before the next start, after ${engine.takenDown} take-downs in this draft: ${engine.armWait} ms`);
  // Not waiting out the longer quiet time here: the draft ends first, which patches at once.
  engine.setParty([]);
  await until(()=>queued()&&engine.status==='ready');

  // The one slow case left: a change when the game is already frozen (a friend's last-moment pick).
  engine.observe('GameStart');engine.setHold({open:true,frozen:true,sealed:true});
  await pause(30);await until(()=>engine.settled);
  mark=Date.now();
  engine.setParty([files[2]]);
  await pause(150);await until(()=>engine.settled&&patched());
  scan=await scanStarted(mark);
  check(patched()&&scan!==null,'a change under the frozen game is patched again');
  console.log(`     late change under a frozen game -> LTK scanning: ${scan?scan-mark:'?'} ms (this game would be started again)`);

  engine.setParty([]);engine.setPersonal(null);
  engine.setHold({open:false,frozen:false,sealed:false});engine.observe('Lobby');
  await pause(100);await until(()=>!engine.busy&&!engine.pendingRestore);
  check(engine.status==='idle'&&!engine.pendingRestore,`undone: status ${engine.status}, journal ${JSON.stringify(engine.journal)}`);
}catch(error){check(false,error.stack||error.message);}
finally{
  clearTimeout(engine.timer);clearTimeout(engine.armTimer);
  await engine.shutdown().catch(()=>{});
  await bridge.quit();
  await rm(dataDir,{recursive:true,force:true});
}
await pause(800);
check(!await ltkRunning(),'LTK Manager is closed again');
console.log(fails.length?`${fails.length} check(s) failed.`:'All checks passed.');
process.exitCode=fails.length?1:0;
