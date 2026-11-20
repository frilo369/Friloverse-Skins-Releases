import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';

const {createErrorLog}=createRequire(import.meta.url)('../src/error-log.cjs');
const folder=()=>path.join(mkdtempSync(path.join(tmpdir(),'friloverse-error-log-')),'data');
const open=dir=>createErrorLog({dir,version:'4.1.0',now:()=>new Date('2026-11-06T18:38:31.000Z')});
const lines=log=>existsSync(log.file)?readFileSync(log.file,'utf8').trim().split('\n').filter(Boolean):[];

test('a shown error is saved with what was going on', () => {
  const log=open(folder());
  log.shown({error:'LTK Manager: boom',champion:'Aatrox',patcher:'failed',connection:'League connected · ChampSelect'},{skin:'riot:266008'});
  assert.deepEqual(lines(log),['2026-11-06T18:38:31.000Z 4.1.0 error: LTK Manager: boom | champion=Aatrox; skin=riot:266008; patcher=failed; connection=League connected · ChampSelect']);
});

test('an error is saved once per appearance, and again if it comes back', () => {
  const log=open(folder());
  log.shown({error:'same'});log.shown({error:'same'});
  assert.equal(lines(log).length,1);
  log.shown({error:''});log.shown({error:'same'});
  assert.equal(lines(log).length,2);
});

test('every field a screen shows is covered, and nothing is saved without an error', () => {
  const log=open(folder());
  log.shown({error:'',champion:'Aatrox',connection:'Waiting'});
  assert.equal(existsSync(log.file),false);
  log.shown({patcherError:'a',databaseError:'b',riotSkinsError:'c',modsError:'d',ltkInstallError:'e',party:{error:'f'}});
  assert.deepEqual(lines(log).map(line=>line.split(' ')[2]),['patcherError:','databaseError:','riotSkinsError:','modsError:','ltkInstallError:','party:']);
});

test('a message stays on one line', () => {
  const log=open(folder());
  log.shown({error:'first\nsecond\r\n  third'});
  assert.match(lines(log)[0],/error: first second third$/);
});

test('a failed request saves its kind and error, not its values', () => {
  const log=open(folder());
  log.failed('guide-key',Object.assign(new Error('Rejected.'),{code:'NOPE'}));
  assert.deepEqual(lines(log),['2026-11-06T18:38:31.000Z 4.1.0 action guide-key: Rejected. | code=NOPE']);
});

test('a note is saved as it is, every time', () => {
  const log=open(folder());
  log.note('panel','moved');log.note('panel','moved');
  assert.deepEqual(lines(log),Array(2).fill('2026-11-06T18:38:31.000Z 4.1.0 note panel: moved'));
});

test('a full log moves aside instead of growing', () => {
  const dir=folder(),log=open(dir);
  log.shown({error:'first'});
  writeFileSync(log.file,'x'.repeat(512*1024));
  log.shown({error:'second'});
  assert.equal(readFileSync(path.join(dir,'errors.old.log'),'utf8').length,512*1024);
  assert.equal(lines(log).length,1);
  assert.match(lines(log)[0],/error: second$/);
});

test('a log that cannot be written never breaks the app', () => {
  const blocked=path.join(mkdtempSync(path.join(tmpdir(),'friloverse-error-log-')),'file');
  writeFileSync(blocked,'not a folder');
  const log=open(blocked);
  assert.doesNotThrow(()=>{log.shown({error:'x'});log.failed('y',new Error('z'));});
});

test('an import problem reaches the log like every other error on a screen',async()=>{
  const {mkdtempSync,readFileSync,rmSync}=await import('node:fs');
  const {tmpdir}=await import('node:os');const {join}=await import('node:path');
  const {createRequire}=await import('node:module');
  const dir=mkdtempSync(join(tmpdir(),'friloverse-errorlog-'));
  try{
    const log=createRequire(import.meta.url)('../src/error-log.cjs').createErrorLog({dir});
    log.shown({importError:'2 old custom files could not be imported.'});
    assert.match(readFileSync(log.file,'utf8'),/importError: 2 old custom files/);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
