import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {FLAG,shouldElevate,relaunchArgs,relaunchElevated}=require('../src/elevation.cjs');
const {taskXml,syncTask,TASK}=require('../src/startup-task.cjs');
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';

const base={packaged:true,preview:false,platform:'win32',argv:['exe'],env:{},elevated:false};

test('an unelevated installed copy asks for administrator rights, nothing else does',()=>{
  assert.equal(shouldElevate(base),true);
  assert.equal(shouldElevate({...base,elevated:true}),false,'already elevated');
  assert.equal(shouldElevate({...base,elevated:null}),false,'unknown is never prompted blindly');
  assert.equal(shouldElevate({...base,packaged:false}),false,'a dev run');
  assert.equal(shouldElevate({...base,preview:true}),false);
  assert.equal(shouldElevate({...base,platform:'linux'}),false);
  assert.equal(shouldElevate({...base,squirrelEvent:true}),false,'Squirrel events run unelevated');
  assert.equal(shouldElevate({...base,argv:['exe',FLAG]}),false,'asked once per start');
  assert.equal(shouldElevate({...base,argv:['exe','--no-elevate']}),false);
  assert.equal(shouldElevate({...base,env:{FRILOVERSE_NO_ELEVATE:'1'}}),false);
});

test('the elevated copy gets the same arguments, quoted, plus the once-only flag',()=>{
  assert.deepEqual(relaunchArgs(['exe','--startup']),['--startup',FLAG]);
  assert.deepEqual(relaunchArgs(['exe','--screenshots=C:/a b']),['"--screenshots=C:/a b"',FLAG]);
  assert.deepEqual(relaunchArgs(['exe',FLAG]),[FLAG],'the flag is never doubled');
});

test('relaunching reports whether Windows started the elevated copy',async()=>{
  let seen;
  const ok=await relaunchElevated({exe:'C:/x/F.exe',argv:['exe','--startup'],run:(program,args,options,done)=>{seen={program,args,options};done(null);}});
  assert.equal(ok,true);
  assert.equal(seen.program,'powershell.exe');
  assert.match(seen.args.at(-1),/-Verb RunAs/);
  assert.equal(seen.options.env.FRILOVERSE_ELEVATE_EXE,'C:/x/F.exe','the path travels in the environment, not the command');
  assert.deepEqual(JSON.parse(seen.options.env.FRILOVERSE_ELEVATE_ARGS),['--startup',FLAG]);
  assert.equal(await relaunchElevated({run:(a,b,c,done)=>done(new Error('The operation was canceled by the user.'))}),false);
  assert.equal(await relaunchElevated({run:()=>{throw new Error('no powershell');}}),false);
});

test('the logon task runs with the highest rights, no time limit and no battery rules',()=>{
  const xml=taskXml({exe:'C:/Users/a & b/F.exe',user:'PC/a'});
  assert.match(xml,/<RunLevel>HighestAvailable<\/RunLevel>/);
  assert.match(xml,/<ExecutionTimeLimit>PT0S<\/ExecutionTimeLimit>/);
  assert.match(xml,/<DisallowStartIfOnBatteries>false</);
  assert.match(xml,/<StopIfGoingOnBatteries>false</);
  assert.ok(xml.includes('<Command>C:/Users/a &amp; b/F.exe</Command>'));
  assert.match(xml,/<Arguments>--startup<\/Arguments>/);
});

test('syncTask creates the task from a UTF-16 file, keeps a current one and deletes it when startup is off',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'friloverse-task-'));
  try{
    const calls=[];let stored='';
    const exec=(program,args,options,done)=>{
      calls.push(args);
      if(args[0]==='/Query'){stored?done(null,stored):done(new Error('not found'));}
      else if(args[0]==='/Create'){readFile(args[args.indexOf('/XML')+1]).then(bytes=>{
        assert.deepEqual([...bytes.subarray(0,2)],[0xff,0xfe],'UTF-16 byte-order mark');
        stored=bytes.subarray(2).toString('utf16le');done(null,'');});}
      else done(null,'');
    };
    assert.equal(await syncTask({exe:'C:/F.exe',enabled:true,user:'PC/a',exec,dir}),'created');
    assert.equal(await syncTask({exe:'C:/F.exe',enabled:true,user:'PC/a',exec,dir}),'kept');
    assert.equal(await syncTask({exe:'C:/Other.exe',enabled:true,user:'PC/a',exec,dir}),'created','a moved program replaces the task');
    assert.equal(await syncTask({exe:'C:/F.exe',enabled:false,exec,dir}),'removed');
    assert.deepEqual(calls.at(-1),['/Delete','/TN',TASK,'/F']);
  }finally{await rm(dir,{recursive:true,force:true});}
});
