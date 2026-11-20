import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtemp,readFile,readdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {prepareQuietStart} from '../src/ltk.mjs';

const {applyPreference,applyForVersion}=createRequire(import.meta.url)('../src/ltk-preference.cjs');
const closed={isOpen:()=>false},open={isOpen:()=>true};
async function withDir(run){
  const dir=await mkdtemp(path.join(tmpdir(),'friloverse-pref-'));
  try{await run(dir);}finally{await rm(dir,{recursive:true,force:true});}
}
const SETTINGS={leaguePath:'D:/League',alwaysStartPatcher:true,accentColor:{preset:'gold',customHue:7},trustedDomains:['a','b'],unknownToUs:1};

test('the preference is set and every other setting stays exactly as it was',()=>withDir(async dir=>{
  const file=path.join(dir,'settings.json');
  await writeFile(file,JSON.stringify(SETTINGS));
  assert.equal(applyPreference(file,closed),'set');
  assert.deepEqual(JSON.parse(await readFile(file,'utf8')),{...SETTINGS,enforceSkinhackScan:false});
  assert.deepEqual(await readdir(dir),['settings.json'],'no temporary file stays');
}));

test('a true value is turned off, and a second run changes nothing',()=>withDir(async dir=>{
  const file=path.join(dir,'settings.json');
  await writeFile(file,JSON.stringify({...SETTINGS,enforceSkinhackScan:true}));
  assert.equal(applyPreference(file,closed),'set');
  assert.equal(JSON.parse(await readFile(file,'utf8')).enforceSkinhackScan,false);
  assert.equal(applyPreference(file,closed),'already');
}));

test('a damaged file is never overwritten, and an open LTK Manager is not raced',()=>withDir(async dir=>{
  const file=path.join(dir,'settings.json');
  await writeFile(file,'{oops');
  assert.equal(applyPreference(file,closed),'unreadable');
  assert.equal(await readFile(file,'utf8'),'{oops');
  await writeFile(file,JSON.stringify(SETTINGS));
  assert.equal(applyPreference(file,open),'open');
  assert.deepEqual(JSON.parse(await readFile(file,'utf8')),SETTINGS);
}));

test('LTK Manager closing between the check and the swap still loses nothing',()=>withDir(async dir=>{
  const file=path.join(dir,'settings.json');let checks=0;
  await writeFile(file,JSON.stringify(SETTINGS));
  assert.equal(applyPreference(file,{isOpen:()=>++checks>1}),'open');
  assert.deepEqual(JSON.parse(await readFile(file,'utf8')),SETTINGS);
  assert.deepEqual(await readdir(dir),['settings.json']);
}));

test('each installed version applies it once; an update applies it again',()=>withDir(async dir=>{
  const file=path.join(dir,'settings.json'),stamp=path.join(dir,'data','stamp.txt');
  await writeFile(file,JSON.stringify(SETTINGS));
  assert.equal(applyForVersion('2.2.0',stamp,{file,...open}),'open','LTK open: not stamped, so the next start tries');
  assert.equal(applyForVersion('2.2.0',stamp,{file,...closed}),'set');
  // LTK Manager saving its settings drops a key it does not know.
  await writeFile(file,JSON.stringify(SETTINGS));
  assert.equal(applyForVersion('2.2.0',stamp,{file,...closed}),'done');
  assert.equal(JSON.parse(await readFile(file,'utf8')).enforceSkinhackScan,undefined);
  assert.equal(applyForVersion('2.3.0',stamp,{file,...closed}),'set');
  assert.equal(JSON.parse(await readFile(file,'utf8')).enforceSkinhackScan,false);
}));

test('on a new PC the first settings LTK Manager gets carry the preference',()=>withDir(async dir=>{
  const file=path.join(dir,'new','settings.json');
  assert.equal(applyPreference(file,closed),'missing');
  await prepareQuietStart(file,{isRunning:async()=>false,league:async()=>'D:/League'});
  assert.equal(JSON.parse(await readFile(file,'utf8')).enforceSkinhackScan,false);
}));
