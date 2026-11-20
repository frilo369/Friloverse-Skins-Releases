import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';

const {PollGate,oneTimer}=createRequire(import.meta.url)('../src/run-guards.cjs');

test('only one poll runs at a time',()=>{
  let now=0;const gate=new PollGate({limit:100,now:()=>now});
  const run=gate.begin();
  assert.equal(run.live,true);
  now=100;assert.equal(gate.begin(),null,'not given up on until past the limit');
  assert.equal(gate.end(run),true);
  assert.equal(run.live,false);
  assert.ok(gate.begin(),'free again once it has ended');
});

test('a hung poll that wakes up late cannot act or end the newer one',()=>{
  let now=0,stuck=0;const gate=new PollGate({limit:100,now:()=>now,onStuck:()=>stuck++});
  const hung=gate.begin();
  now=101;const newer=gate.begin();
  assert.ok(newer);assert.equal(stuck,1);
  assert.equal(hung.live,false,'told it is out of date');
  assert.equal(newer.live,true);
  assert.equal(gate.end(hung),false,'the late one ends nothing');
  assert.equal(newer.live,true);
  now=150;assert.equal(gate.begin(),null,'the newer one still holds the turn');
  assert.equal(gate.end(newer),true);
});

test('setting a retry again replaces the one waiting',t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  let runs=0;const retry=oneTimer(()=>runs++);
  retry.set(1000);t.mock.timers.tick(500);
  retry.set(1000);t.mock.timers.tick(500);
  assert.equal(runs,0);
  assert.equal(retry.pending,true);
  t.mock.timers.tick(500);
  assert.equal(runs,1,'many checks, one retry');
  assert.equal(retry.pending,false);
  t.mock.timers.tick(5000);
  assert.equal(runs,1);
});

test('a retry can be cancelled',t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  let runs=0;const retry=oneTimer(()=>runs++);
  retry.set(1000);retry.cancel();t.mock.timers.tick(5000);
  assert.equal(runs,0);assert.equal(retry.pending,false);
});

const {stillThere,retryDelay,finishWithin}=createRequire(import.meta.url)('../src/run-guards.cjs');

test('something found is looked at again, and one failed look is not gone',async()=>{
  let now=0,present=true,looks=0;
  const watch=stillThere(async()=>{looks++;if(!present)throw new Error('gone');},{every:60000,soon:5000,now:()=>now});
  assert.equal(watch.due,false,'just found');
  now=60000;assert.equal(watch.due,true);
  assert.equal(await watch.check(),false);
  assert.equal(watch.due,false);
  now=120000;present=false;
  assert.equal(await watch.check(),false,'could be an update swapping the file');
  now=124999;assert.equal(watch.due,false);
  now=125000;assert.equal(watch.due,true,'the second look comes soon');
  assert.equal(await watch.check(),true);
  assert.equal(looks,3);
});

test('a look that comes back clears the missed one',async()=>{
  let now=60000,present=false;
  const watch=stillThere(async()=>{if(!present)throw new Error('gone');},{every:60000,soon:5000,now:()=>now});
  await watch.check();present=true;now=65000;
  assert.equal(await watch.check(),false);
  present=false;now=125000;
  assert.equal(await watch.check(),false,'one miss again, not the second in a row');
});

test('only one look runs at a time',async()=>{
  let now=60000,finish;
  const watch=stillThere(()=>new Promise(resolve=>{finish=resolve;}),{every:60000,now:()=>now});
  const running=watch.check();
  assert.equal(watch.due,false);
  finish();await running;
});

test('being limited waits longer each time and never before GitHub says',()=>{
  const now=1000,minute=60*1000;
  assert.equal(retryDelay({now}),5*minute,'an ordinary failure stays at 5 minutes');
  assert.equal(retryDelay({limitedRuns:1,now}),5*minute);
  assert.equal(retryDelay({limitedRuns:2,now}),10*minute);
  assert.equal(retryDelay({limitedRuns:3,now}),20*minute);
  assert.equal(retryDelay({limitedRuns:9,now}),60*minute,'and stops at an hour');
  assert.equal(retryDelay({limitedRuns:1,retryAt:now+30*minute,now}),30*minute+30*1000);
  assert.equal(retryDelay({limitedRuns:1,retryAt:now+500*minute,now}),60*minute);
});

test('quitting waits for the work, but not forever',async()=>{
  assert.equal(await finishWithin(Promise.resolve(),1000),true);
  assert.equal(await finishWithin(Promise.reject(new Error('failed')),1000),true,'a failure must not stop the quit');
  assert.equal(await finishWithin(new Promise(()=>{}),10),false);
});

test('a long log moves aside, keeps its order, and a log failure is no problem',async()=>{
  const {rotatingLog}=(await import('../src/run-guards.cjs')).default;
  const files={a:'x'.repeat(8),b:''};let breakRename=false,breakAppend=false;
  const io={
    stat:async name=>({size:Buffer.byteLength(files[name])}),
    rename:async(from,to)=>{if(breakRename)throw new Error('locked');files[to]=files[from];files[from]='';},
    appendFile:async(name,line)=>{if(breakAppend)throw new Error('full');await null;files[name]+=line;},
  };
  const log=rotatingLog('a','b',{limit:10,io});
  log('1\n');await log('2\n');
  assert.equal(files.a,'2\n','over the limit: a new file');
  assert.equal(files.b,`${'x'.repeat(8)}1\n`,'and the old one kept, its lines in order');
  await log('34\n');
  assert.equal(files.a,'2\n34\n');
  breakRename=true;await log('7890123\n');
  assert.equal(files.a,'2\n34\n7890123\n','a file that cannot move still gets the line');
  breakAppend=true;await log('lost\n');
  breakAppend=false;await log('next\n');
  assert.match(files.a,/next\n$/);
});
