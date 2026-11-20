import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {AppUpdater,shortProblem} from '../src/app-updater.mjs';

test('the app updater checks the separate feed and waits for a safe restart',async()=>{
  const native=new EventEmitter(),messages=[];let checked=0,installed=0,safe=false,prepared=0;
  native.setFeedURL=value=>{native.url=value.url;};native.checkForUpdates=()=>{checked++;};native.quitAndInstall=()=>{installed++;};
  const updater=new AppUpdater({updater:native,installed:true,version:'0.4.0',onStatus:value=>messages.push(value),canApply:async()=>safe,beforeApply:async()=>{prepared++;}});
  // 6.3: GitHub's newest release, which serves deltas (update.electronjs.org passed on only one package).
  assert.equal(native.url,'https://github.com/frilo369/Friloverse-Skins-Releases/releases/latest/download');
  updater.check();updater.check();assert.equal(checked,1);
  native.emit('update-downloaded');await new Promise(resolve=>setImmediate(resolve));assert.equal(installed,0);
  safe=true;await updater.applyWhenSafe();assert.equal(prepared,1);assert.equal(installed,1);
  assert.match(messages.at(-1),/waiting for a safe moment/);
});

test('a failed check reaches the log, and only a check the player asked for counts as theirs',()=>{
  const native=new EventEmitter(),seen=[],problems=[];
  native.setFeedURL=()=>{};native.checkForUpdates=()=>{};
  let updater;updater=new AppUpdater({updater:native,installed:true,version:'4.1.0',onStatus:()=>seen.push(updater.manual),onProblem:error=>problems.push(error.message),canApply:async()=>false,beforeApply:async()=>{}});
  updater.check({manual:true});native.emit('error',new Error('offline'));
  updater.check();native.emit('update-not-available');
  assert.deepEqual(problems,['offline']);
  assert.deepEqual(seen,[true,false]);
  assert.equal(updater.manual,false);
});

const pause=ms=>new Promise(done=>setTimeout(done,ms));
function retrying(answer){
  const native=new EventEmitter(),calls={checks:0};
  native.setFeedURL=()=>{};native.checkForUpdates=()=>{calls.checks++;answer?.(native,calls.checks);};
  return {native,calls,updater:new AppUpdater({updater:native,installed:true,version:'7.3.0',onStatus:()=>{},canApply:async()=>false,beforeApply:async()=>{},retryAfter:1})};
}

test('a failed check is tried once more soon after',async()=>{
  const {native,calls,updater}=retrying();
  updater.check();native.emit('error',new Error('The remote name could not be resolved'));
  await pause(25);
  assert.equal(calls.checks,2);
  native.emit('update-not-available');
  assert.equal(updater.retrying,false);
});

test('a retry that fails too leaves it to the hourly check',async()=>{
  const {native,calls,updater}=retrying();
  updater.check();native.emit('error',new Error('offline'));
  await pause(25);assert.equal(calls.checks,2);
  native.emit('error',new Error('offline'));
  await pause(25);assert.equal(calls.checks,2);
  assert.equal(updater.retryTimer,null);
  updater.check();assert.equal(calls.checks,3);
  native.emit('error',new Error('offline'));
  await pause(25);assert.equal(calls.checks,4,'a later failure has its own one retry');
  native.emit('update-not-available');
});

test('a feed with no release is not asked again in five minutes',async()=>{
  const {native,calls,updater}=retrying();
  updater.check();native.emit('error',new Error('The remote server returned an error: (404) Not Found.'));
  await pause(25);
  assert.equal(calls.checks,1);
  assert.equal(updater.retryTimer,null);
});

test('a check that throws at once is retried as well',async()=>{
  const {calls,updater}=retrying((native,count)=>{if(count===1)throw new Error('Update.exe was busy');native.emit('update-not-available');});
  updater.check();
  await pause(25);
  assert.equal(calls.checks,2);
});

test('a check the player starts replaces a retry that was waiting',async()=>{
  const native=new EventEmitter();let checks=0;
  native.setFeedURL=()=>{};native.checkForUpdates=()=>{checks++;};
  const updater=new AppUpdater({updater:native,installed:true,version:'7.3.0',onStatus:()=>{},canApply:async()=>false,beforeApply:async()=>{},retryAfter:20});
  updater.check();native.emit('error',new Error('offline'));
  updater.check({manual:true});native.emit('update-not-available');
  await pause(40);
  assert.equal(checks,2);
});

test('portable builds do not pretend that automatic app updates are available',()=>{
  const native=new EventEmitter();let message='';
  const updater=new AppUpdater({updater:native,installed:false,version:'0.4.0',onStatus:value=>{message=value;},canApply:async()=>false,beforeApply:async()=>{}});
  updater.check();assert.match(message,/Install Friloverse/);
});

test('an update waits if the match changes during preparation',async()=>{
  const native=new EventEmitter();let installs=0;
  native.setFeedURL=()=>{};native.quitAndInstall=()=>{installs++;};
  const updater=new AppUpdater({updater:native,installed:true,version:'0.4.0',onStatus:()=>{},canApply:async()=>true,beforeApply:async()=>false});
  updater.ready=true;await updater.applyWhenSafe();
  assert.equal(installs,0);assert.equal(updater.ready,true);
});

test('failed installation restores the normal close behavior',async()=>{
  const native=new EventEmitter();let restored=0,message='';
  native.setFeedURL=()=>{};native.quitAndInstall=()=>{throw Error('install failed');};
  const updater=new AppUpdater({updater:native,installed:true,version:'0.4.0',onStatus:value=>{message=value;},canApply:async()=>true,beforeApply:async()=>true,cancelApply:async()=>{restored++;}});
  updater.ready=true;await updater.applyWhenSafe();
  assert.equal(restored,1);assert.equal(updater.ready,true);assert.match(message,/^Could not apply the app update\. Friloverse tries again later\.$/);assert.doesNotMatch(message,/install failed/);
});

test('an installation Squirrel refuses after quitting began also restores the normal close behavior',async()=>{
  const native=new EventEmitter(),problems=[];let restored=0,checks=0,message='';
  native.setFeedURL=()=>{};native.quitAndInstall=()=>{};native.checkForUpdates=()=>{checks++;};
  const updater=new AppUpdater({updater:native,installed:true,version:'0.4.0',onStatus:value=>{message=value;},onProblem:error=>problems.push(error.message),
    canApply:async()=>true,beforeApply:async()=>true,cancelApply:async()=>{restored++;}});
  updater.ready=true;await updater.applyWhenSafe();
  assert.equal(updater.ready,false);
  native.emit('error',new Error('Squirrel could not apply the package'));await new Promise(resolve=>setImmediate(resolve));
  assert.equal(restored,1);assert.equal(updater.ready,true,'the update is kept for the next safe moment');
  assert.deepEqual(problems,['Squirrel could not apply the package']);
  assert.match(message,/^Could not apply the app update\. Friloverse tries again later\.$/);
  assert.equal(updater.retryTimer,null,'no check is started: the update is already here');
  native.emit('error',new Error('a later check failed'));
  assert.equal(restored,1,'an error from a later check undoes nothing');
  clearTimeout(updater.retryTimer);
});

test('a manual update check can apply a downloaded update with automatic updates off',async()=>{
  const native=new EventEmitter();let installs=0;
  native.setFeedURL=()=>{};native.quitAndInstall=()=>{installs++;};native.checkForUpdates=()=>{};
  const updater=new AppUpdater({updater:native,installed:true,version:'0.4.0',onStatus:()=>{},canApply:async({manual})=>manual,beforeApply:async()=>true});
  updater.ready=true;await updater.applyWhenSafe();assert.equal(installs,0);
  updater.check({manual:true});await new Promise(resolve=>setImmediate(resolve));
  assert.equal(installs,1);
});

test('a failed check is said plainly, and one that never answers does not block later checks',()=>{
  const native=new EventEmitter(),messages=[];let checked=0,time=0;
  native.setFeedURL=()=>{};native.checkForUpdates=()=>{checked++;};
  const updater=new AppUpdater({updater:native,installed:true,version:'1.5.0',onStatus:value=>messages.push(value),canApply:async()=>false,beforeApply:async()=>{},now:()=>time});
  const log=console.error;console.error=()=>{};
  try{native.emit('error',new Error('Update check failed. The following information: a very long Squirrel log'));}finally{console.error=log;}
  assert.match(messages.at(-1),/^Could not check for app updates/);assert.doesNotMatch(messages.at(-1),/Squirrel/);
  updater.check();updater.check();assert.equal(checked,1);
  time=2*60*60*1000;updater.check();assert.equal(checked,2);
});

const waitingUpdater=(extra={})=>{
  const native=new EventEmitter();let checked=0;
  native.setFeedURL=()=>{};native.checkForUpdates=()=>{checked++;};native.quitAndInstall=()=>{};
  const updater=new AppUpdater({updater:native,installed:true,version:'7.0.0',onStatus:()=>{},canApply:async()=>false,beforeApply:async()=>false,...extra});
  return {native,updater,checks:()=>checked};
};

test('the databases are told how the app check ended',async()=>{
  const none=waitingUpdater();let answer=none.updater.checkAndWait();assert.equal(none.checks(),1);
  none.native.emit('update-not-available');assert.equal(await answer,'none');
  const failed=waitingUpdater();answer=failed.updater.checkAndWait();
  const log=console.error;console.error=()=>{};
  try{failed.native.emit('error',new Error('offline'));}finally{console.error=log;}
  assert.equal(await answer,'failed');
  const found=waitingUpdater();answer=found.updater.checkAndWait();
  found.native.emit('update-available');found.native.emit('update-downloaded');assert.equal(await answer,'downloaded');
  assert.equal(await found.updater.checkAndWait(),'downloaded');
  const portable=waitingUpdater({installed:false});assert.equal(await portable.updater.checkAndWait(),'not-installed');
});

test('a check that never answers lets the databases go on, and a download gets longer',async()=>{
  // The updater's own timers do not keep a program alive, on purpose.
  const alive=setInterval(()=>{},1000);
  try{
    const quiet=waitingUpdater();
    assert.equal(await quiet.updater.checkAndWait({answerWithin:5}),'timeout');
    assert.equal(quiet.updater.waiters.length,0);
    const slow=waitingUpdater();let over=false;
    const answer=slow.updater.checkAndWait({answerWithin:5,downloadWithin:60}).then(value=>{over=true;return value;});
    slow.native.emit('update-available');
    await new Promise(resolve=>setTimeout(resolve,25));assert.equal(over,false);
    slow.native.emit('update-downloaded');assert.equal(await answer,'downloaded');
  }finally{clearInterval(alive);}
});

test('a failed check is logged as one short line',()=>{
  assert.equal(shortProblem(new Error('Command failed: 4294967295\nSystem.AggregateException: x ---> System.Net.WebException: The remote server returned an error: (504) Gateway Timeout.\n   at System.Net')),'remote server returned an error: (504) Gateway Timeout');
  assert.equal(shortProblem(new Error('offline\nmore')),'offline');
});

test('a failed check says it in plain words and keeps the details for the log',()=>{
  const native=new EventEmitter(),messages=[],problems=[];
  native.setFeedURL=()=>{};native.checkForUpdates=()=>{throw Error('Squirrel exploded');};
  const updater=new AppUpdater({updater:native,installed:true,version:'0.4.0',retryAfter:60000,onStatus:value=>messages.push(value),onProblem:error=>problems.push(error.message),canApply:async()=>false,beforeApply:async()=>{}});
  updater.check();
  clearTimeout(updater.retryTimer);
  assert.equal(messages.at(-1),'Could not check for app updates. Friloverse tries again later.');
  assert.deepEqual(problems,['Squirrel exploded']);
});
