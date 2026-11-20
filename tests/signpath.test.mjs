import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,readdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {identity,signFile,signingConfig,windowsSignOption} from '../scripts/sign.mjs';
import {applySigned,importSigned} from '../scripts/signpath.mjs';

function pe(extra=0,signed=false){
  const buffer=Buffer.alloc(0x400);
  buffer.writeUInt16LE(0x5a4d,0);
  buffer.writeUInt32LE(0x80,0x3c);
  buffer.writeUInt32LE(0x00004550,0x80);
  buffer.writeUInt16LE(0x20b,0x98);
  buffer.writeUInt8(extra,0x300);
  const entry=0x98+112+4*8;
  if(signed){buffer.writeUInt32LE(0x300,entry);buffer.writeUInt32LE(0x100,entry+4);}
  return buffer;
}

async function withDir(run){
  const dir=await mkdtemp(path.join(tmpdir(),'friloverse-signpath-'));
  try{return await run(dir);}finally{await rm(dir,{recursive:true,force:true});}
}

test('external signing has its own identity and needs no certificate',()=>{
  const config=signingConfig({FRILOVERSE_SIGN_EXTERNAL:'1'});
  assert.equal(config.external,true);
  assert.equal(config.collect,'');
  assert.equal(identity(config),identity(signingConfig({FRILOVERSE_SIGN_EXTERNAL:'1',FRILOVERSE_SIGN_THUMBPRINT:'AA'})));
  assert.ok(windowsSignOption({FRILOVERSE_SIGN_EXTERNAL:'1'}).hookModulePath.endsWith('sign.mjs'));
});

test('a program with no signed copy is collected by its key and left unsigned',async()=>withDir(async dir=>{
  const collect=path.join(dir,'collect'),cache=path.join(dir,'cache'),file=path.join(dir,'a.exe');
  const original=pe(1);
  await writeFile(file,original);
  const config=signingConfig({FRILOVERSE_SIGN_EXTERNAL:'1',FRILOVERSE_SIGN_COLLECT:collect});
  assert.equal(await signFile(file,{config,cache}),'collected');
  assert.deepEqual(await readFile(file),original);
  const [name]=await readdir(collect);
  assert.match(name,/^[0-9a-f]{64}\.exe$/);
  assert.deepEqual(await readFile(path.join(collect,name)),original);
}));

test('a file the pass will rebuild is left alone and not collected',async()=>withDir(async dir=>{
  const collect=path.join(dir,'collect'),cache=path.join(dir,'cache');
  const setup=path.join(dir,'Friloverse-1-Complete-Setup.exe'),app=path.join(dir,'a.exe');
  await writeFile(setup,pe(7));
  await writeFile(app,pe(8));
  const config=signingConfig({FRILOVERSE_SIGN_EXTERNAL:'1',FRILOVERSE_SIGN_COLLECT:collect,FRILOVERSE_SIGN_COLLECT_SKIP:'Complete-Setup\.exe$'});
  assert.equal(await signFile(setup,{config,cache}),'left');
  assert.equal(await signFile(app,{config,cache}),'collected');
  assert.equal((await readdir(collect)).length,1);
}));

test('without a collect folder an unsigned program stops the build',async()=>withDir(async dir=>{
  const file=path.join(dir,'a.dll');
  await writeFile(file,pe(2));
  await assert.rejects(signFile(file,{config:signingConfig({FRILOVERSE_SIGN_EXTERNAL:'1'}),cache:path.join(dir,'cache')}),/no signed copy/);
}));

test('signed files that come back are kept and put into the next build',async()=>withDir(async dir=>{
  const collect=path.join(dir,'collect'),cache=path.join(dir,'cache'),back=path.join(dir,'back'),file=path.join(dir,'a.exe');
  await writeFile(file,pe(3));
  const config=signingConfig({FRILOVERSE_SIGN_EXTERNAL:'1',FRILOVERSE_SIGN_COLLECT:collect});
  await signFile(file,{config,cache});
  const [name]=await readdir(collect);
  await mkdir(back,{recursive:true});
  const signed=pe(3,true);
  await writeFile(path.join(back,name),signed);
  assert.equal(await importSigned(back,{cache}),1);
  assert.equal(await signFile(file,{config,cache}),'cached');
  assert.deepEqual(await readFile(file),signed);
  // A program already signed is left alone, and apply fails for one that was never collected.
  await applySigned([file],{config:signingConfig({FRILOVERSE_SIGN_EXTERNAL:'1'}),cache});
  const other=path.join(dir,'b.exe');
  await writeFile(other,pe(4));
  await assert.rejects(applySigned([other],{config:signingConfig({FRILOVERSE_SIGN_EXTERNAL:'1'}),cache}),/no signed copy/);
}));

test('a returned file with no signature or a foreign name is refused before anything is kept',async()=>withDir(async dir=>{
  const cache=path.join(dir,'cache'),back=path.join(dir,'back');
  await mkdir(back,{recursive:true});
  const key='a'.repeat(64);
  await writeFile(path.join(back,`${key}.exe`),pe(5,true));
  await writeFile(path.join(back,`${'b'.repeat(64)}.exe`),pe(6,false));
  await assert.rejects(importSigned(back,{cache}),/without a signature/);
  await assert.rejects(readdir(cache),/ENOENT/);
  await rm(path.join(back,`${'b'.repeat(64)}.exe`));
  await writeFile(path.join(back,'notes.txt'),'x');
  await assert.rejects(importSigned(back,{cache}),/not named like/);
  await assert.rejects(importSigned(path.join(dir,'empty-missing'),{cache}),/ENOENT/);
}));
