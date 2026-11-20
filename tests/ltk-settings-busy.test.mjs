import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,readdirSync,renameSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {prepareQuietStart} from '../src/ltk.mjs';

test('a settings file Windows holds for a moment is written once it is free',async()=>{
  const dir=mkdtempSync(path.join(tmpdir(),'friloverse-busy-')),file=path.join(dir,'settings.json');
  writeFileSync(file,JSON.stringify({keep:1}));
  const busy=code=>Object.assign(new Error('rename failed'),{code});
  let calls=0;
  const renameFile=async(from,to)=>{if(++calls<3)throw busy('EPERM');renameSync(from,to);};
  assert.equal(await prepareQuietStart(file,{isRunning:async()=>false,renameFile,pause:async()=>{}}),true);
  assert.equal(calls,3);
  assert.equal(JSON.parse(readFileSync(file,'utf8')).keep,1);
  assert.deepEqual(readdirSync(dir),['settings.json']);
  // Still held: plain words, and no temp file left behind.
  writeFileSync(file,JSON.stringify({keep:2}));
  await assert.rejects(prepareQuietStart(file,{isRunning:async()=>false,renameFile:async()=>{throw busy('EBUSY');},pause:async()=>{}}),error=>error.plain===true&&!/EBUSY/.test(error.message));
  assert.deepEqual(readdirSync(dir),['settings.json']);
  // Any other failure is not a lock, so it is not waited on.
  let others=0;
  await assert.rejects(prepareQuietStart(file,{isRunning:async()=>false,renameFile:async()=>{others++;throw busy('ENOSPC');},pause:async()=>{}}),/rename failed/);
  assert.equal(others,1);
  // LTK Manager came back while waiting: it owns the file again.
  let open=false;
  assert.equal(await prepareQuietStart(file,{isRunning:async()=>open,renameFile:async()=>{open=true;throw busy('EPERM');},pause:async()=>{}}),false);
  assert.equal(JSON.parse(readFileSync(file,'utf8')).keep,2);
});
