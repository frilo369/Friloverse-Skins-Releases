import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {hasSignature,identity,signArgs,signFile,signingConfig,windowsSignOption} from '../scripts/sign.mjs';

// A minimal PE header: "MZ", e_lfanew at 0x3c, "PE\0\0", PE32+ optional header. The certificate
// table is data directory 4, 112 bytes after the optional header's start for PE32+.
function pe({signed=false,plus=true}={}){
  const buffer=Buffer.alloc(0x400);
  buffer.writeUInt16LE(0x5a4d,0);
  buffer.writeUInt32LE(0x80,0x3c);
  buffer.writeUInt32LE(0x00004550,0x80);
  buffer.writeUInt16LE(plus?0x20b:0x10b,0x98);
  const entry=0x98+(plus?112:96)+4*8;
  if(signed){buffer.writeUInt32LE(0x300,entry);buffer.writeUInt32LE(0x100,entry+4);}
  return buffer;
}

async function withDir(run){
  const dir=await mkdtemp(path.join(tmpdir(),'friloverse-sign-'));
  try{return await run(dir);}finally{await rm(dir,{recursive:true,force:true});}
}

test('signing is off without a certificate and a pfx needs its password',()=>{
  assert.equal(signingConfig({}),null);
  assert.throws(()=>signingConfig({FRILOVERSE_SIGN_PFX:'a.pfx'}),/PASSWORD/);
  assert.ok(signingConfig({FRILOVERSE_SIGN_PFX:'a.pfx',FRILOVERSE_SIGN_PASSWORD:'x'}));
  assert.equal(windowsSignOption({}),undefined);
  assert.throws(()=>windowsSignOption({FRILOVERSE_REQUIRE_SIGNING:'1'}),/unsigned/);
  assert.ok(windowsSignOption({FRILOVERSE_SIGN_THUMBPRINT:'ab cd'}).hookModulePath.endsWith('sign.mjs'));
});

test('signtool arguments use SHA-256 with a timestamp for each way of choosing a certificate',()=>{
  const thumb=signingConfig({FRILOVERSE_SIGN_THUMBPRINT:'AB CD EF'});
  assert.deepEqual(signArgs(thumb,'x.exe'),['sign','/fd','sha256','/tr','http://timestamp.digicert.com','/td','sha256','/sha1','ABCDEF','x.exe']);
  const pfx=signingConfig({FRILOVERSE_SIGN_PFX:'c.pfx',FRILOVERSE_SIGN_PASSWORD:'pw',FRILOVERSE_SIGN_TIMESTAMP:'http://time.certum.pl'});
  const args=signArgs(pfx,'x.exe');
  assert.deepEqual(args.slice(0,6),['sign','/fd','sha256','/tr','http://time.certum.pl','/td']);
  assert.ok(args.includes('/f')&&args.includes('/p')&&args.at(-1)==='x.exe');
  const raw=signingConfig({FRILOVERSE_SIGN_PARAMS:'/fd sha256 /dlib "C:\\Azure Tools\\dlib.dll" /dmdf m.json'});
  assert.deepEqual(signArgs(raw,'x.exe'),['sign','/fd','sha256','/dlib','C:\\Azure Tools\\dlib.dll','/dmdf','m.json','x.exe']);
});

test('the signer identity ignores the password but follows the certificate',()=>{
  const a=signingConfig({FRILOVERSE_SIGN_PFX:'c.pfx',FRILOVERSE_SIGN_PASSWORD:'one'});
  const b=signingConfig({FRILOVERSE_SIGN_PFX:'c.pfx',FRILOVERSE_SIGN_PASSWORD:'two'});
  const c=signingConfig({FRILOVERSE_SIGN_THUMBPRINT:'AA'});
  assert.equal(identity(a),identity(b));
  assert.notEqual(identity(a),identity(c));
});

test('a PE file with a certificate table counts as signed, anything else does not',()=>{
  assert.equal(hasSignature(pe()),false);
  assert.equal(hasSignature(pe({signed:true})),true);
  assert.equal(hasSignature(pe({signed:true,plus:false})),true);
  assert.equal(hasSignature(Buffer.from('not a program')),false);
  assert.equal(hasSignature(Buffer.alloc(0x100)),false);
});

test('signFile signs once, reuses the signed copy for identical files and leaves signed files alone',async()=>withDir(async dir=>{
  const cache=path.join(dir,'cache');
  const signtool=path.join(dir,'signtool.exe');
  await writeFile(signtool,'stand-in');
  const config={...signingConfig({FRILOVERSE_SIGN_THUMBPRINT:'AA'}),signtool};
  const calls=[];
  // The stand-in writes a certificate table into the file, as signtool would.
  const exec=async(program,args)=>{
    calls.push(args.at(-1));
    await writeFile(args.at(-1),pe({signed:true}));
  };
  const first=path.join(dir,'a.exe');
  const second=path.join(dir,'b.exe');
  const done=path.join(dir,'c.dll');
  await writeFile(first,pe());
  await writeFile(second,pe());
  await writeFile(done,pe({signed:true}));
  assert.equal(await signFile(first,{config,exec,cache}),'signed');
  assert.equal(await signFile(second,{config,exec,cache}),'cached');
  assert.equal(await signFile(done,{config,exec,cache}),'skipped');
  assert.deepEqual(calls,[first]);
  assert.deepEqual(await readFile(second),pe({signed:true}));
}));

test('signFile fails when signtool leaves no signature, and keeps nothing in the cache',async()=>withDir(async dir=>{
  const cache=path.join(dir,'cache');
  const signtool=path.join(dir,'signtool.exe');
  await writeFile(signtool,'stand-in');
  const config={...signingConfig({FRILOVERSE_SIGN_THUMBPRINT:'AA'}),signtool};
  const file=path.join(dir,'a.exe');
  await writeFile(file,pe());
  await assert.rejects(signFile(file,{config,exec:async()=>{},cache}),/no signature/);
  await assert.rejects(signFile(file,{config:{...config,signtool:path.join(dir,'missing.exe')},exec:async()=>{},cache}),/signtool.exe was not found/);
}));
