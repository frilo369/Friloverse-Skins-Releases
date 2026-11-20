import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import {parseProcessNames,processRunning} from '../src/process-list.mjs';

test('process checks fail closed on incomplete output and recognize game and LTK Manager names',()=>{
  const task='"tasklist.exe","20","Console","1","1,000 K"';
  const game='"League of Legends.exe","30","Console","1","1,000 K"';
  const ltk='"ltk-manager.exe","40","Console","1","1,000 K"';
  assert.deepEqual([...parseProcessNames(task)],['tasklist.exe']);
  assert.ok(parseProcessNames([task,game,ltk].join('\r\n')).has('league of legends.exe'));
  for(const output of ['',null,'INFO: No tasks',game,`${task}\ninvalid`])assert.equal(parseProcessNames(output),null);
});

test('a Windows snapshot sees the current process and rejects a missing process', {skip:process.platform!=='win32'},async()=>{
  const require=createRequire(import.meta.url);
  const native=require('../src/windows-process.cjs'),names=native.processNames();
  const ownName=path.basename(process.execPath).toLowerCase();
  assert.ok(names.has('system'));
  assert.ok(names.has(ownName));
  assert.ok(native.listProcesses().some(row=>row.pid===process.pid&&row.name===ownName));
  assert.equal(await processRunning(ownName),true);
  assert.equal(await processRunning(`${randomUUID()}.exe`),false);
});
